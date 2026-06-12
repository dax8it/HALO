import { basename } from "node:path";
import { Bunqueue, type Job } from "bunqueue/client";
import type { DatabaseHandle } from "../db/client";
import type { LiveEventStore } from "../live/events";
import { ingestTelemetry } from "../telemetry/storage";
import {
  jsonlSpansToOtlp,
  normalizeHexId,
  streamJsonlSpans,
  type FileImportContext,
} from "./parser";
import {
  createFileImportJob,
  getFileImportJob,
  isFileImportCancelled,
  listFileImportJobs,
  markInterruptedFileImports,
  publishFileImportJob,
  updateFileImportJob,
} from "./storage";
import type { FileImportJob, JsonlSpanRecord } from "./types";

type ImportJobData = {
  appJobId: string;
};

type ImportJobResult = {
  appJobId: string;
  cancelled?: boolean;
  importedTraces?: number;
};

type FileImportServiceOptions = {
  database: DatabaseHandle;
  live: LiveEventStore;
};

export type FileImportService = ReturnType<typeof createFileImportService>;

const IMPORT_QUEUE_NAME = "file-imports";
const IMPORT_ROUTE = "file.import";
// Spans per ingest batch. Lines in real exports run ~75 KB, so this keeps
// individual OTLP payloads in the tens of megabytes at worst.
const INGEST_BATCH_SPAN_LIMIT = 250;
const PROGRESS_UPDATE_SPAN_INTERVAL = 500;

export function createFileImportService(options: FileImportServiceOptions) {
  const { database, live } = options;
  markInterruptedFileImports(database.sqlite);

  let queue: Bunqueue<ImportJobData, ImportJobResult>;
  queue = new Bunqueue<ImportJobData, ImportJobResult>(IMPORT_QUEUE_NAME, {
    concurrency: 1,
    dataPath: queueDataPath(database.path),
    heartbeatInterval: 2_000,
    defaultJobOptions: {
      durable: true,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
    dlq: {
      autoRetry: false,
      maxEntries: 500,
    },
    embedded: true,
    retry: {
      delay: 750,
      maxAttempts: 2,
      // File reads either work or fail deterministically; one retry covers
      // transient fs hiccups without rescanning huge files repeatedly.
      retryIf: () => true,
      strategy: "jitter",
    },
    routes: {
      [IMPORT_ROUTE]: async (job) =>
        processImportJob({
          database,
          job,
          live,
          queue,
        }),
    },
  });

  queue.on("failed", (job, error) => {
    const appJobId = job.data.appJobId;
    const current = getFileImportJob(database.sqlite, appJobId);
    if (!current || current.status === "cancelled") return;
    const updated = updateFileImportJob(database.sqlite, appJobId, {
      errorMessage: error.message,
      finishedAt: Date.now(),
      status: "failed",
    });
    publishFileImportJob(live, updated);
  });

  return {
    async cancel(jobId: string) {
      const job = getFileImportJob(database.sqlite, jobId);
      if (!job) return null;
      const updated = updateFileImportJob(database.sqlite, jobId, {
        errorMessage: "Import cancelled by user.",
        finishedAt: Date.now(),
        status: "cancelled",
      });
      publishFileImportJob(live, updated);
      if (job.bunqueueJobId) queue.cancel(job.bunqueueJobId);
      return updated;
    },

    close(force?: boolean) {
      return queue.close(force);
    },

    get(jobId: string) {
      return getFileImportJob(database.sqlite, jobId);
    },

    list(limit?: number) {
      return listFileImportJobs(database.sqlite, limit);
    },

    async start(input: { filePath: string }): Promise<FileImportJob> {
      const filePath = input.filePath.trim();
      if (!filePath) throw new Error("A file path is required");
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        throw new Error(`File not found: ${filePath}`);
      }

      const appJob = createFileImportJob(database.sqlite, {
        fileName: basename(filePath),
        filePath,
        fileSizeBytes: file.size,
      });
      const queued = await queue.add(
        IMPORT_ROUTE,
        { appJobId: appJob.id },
        {
          durable: true,
          jobId: appJob.id,
          priority: 5,
        },
      );
      const updated = updateFileImportJob(database.sqlite, appJob.id, {
        bunqueueJobId: queued.id,
        status: "queued",
      });
      publishFileImportJob(live, updated);
      return updated;
    },
  };
}

async function processImportJob(input: {
  database: DatabaseHandle;
  job: Job<ImportJobData>;
  live: LiveEventStore;
  queue: Bunqueue<ImportJobData, ImportJobResult>;
}): Promise<ImportJobResult> {
  const { database, job, live, queue } = input;
  const appJobId = job.data.appJobId;
  const appJob = getFileImportJob(database.sqlite, appJobId);
  if (!appJob || !["queued", "running"].includes(appJob.status)) {
    return { appJobId, cancelled: true };
  }

  const signal = queue.getSignal(job.id) ?? undefined;
  const context: FileImportContext = {
    fileName: appJob.fileName,
    importedAt: Date.now(),
    importJobId: appJobId,
  };

  await updateProgress({
    database,
    job,
    live,
    patch: {
      currentTraceName: "Scanning file…",
      errorMessage: null,
      progress: 1,
      startedAt: Date.now(),
      status: "running",
    },
  });

  try {
    // Pass 1: exact totals plus the file-wide span-id map, so progress is
    // accurate and parent references survive batches that split a trace.
    let skippedLines = 0;
    const spanIdsByTrace = new Map<string, Set<string>>();
    let totalSpans = 0;
    for await (const { record, traceId } of streamJsonlSpans(
      appJob.filePath,
      () => {
        skippedLines += 1;
      },
    )) {
      assertNotCancelled(database, appJobId, signal);
      totalSpans += 1;
      const spanId = normalizeHexId(record.span_id, 16);
      if (!spanId) continue;
      const ids = spanIdsByTrace.get(traceId) ?? new Set<string>();
      ids.add(spanId);
      spanIdsByTrace.set(traceId, ids);
    }

    if (totalSpans === 0) {
      throw new Error(
        skippedLines > 0
          ? `No importable spans found — all ${skippedLines} lines were invalid.`
          : "The file contains no spans.",
      );
    }

    const counters = {
      failedTraces: 0,
      importedSpans: 0,
      importedTraceIds: new Set<string>(),
      processedSpans: 0,
    };
    await updateProgress({
      database,
      job,
      live,
      patch: {
        currentTraceName: null,
        progress: progressFor(0, totalSpans),
        skippedLines,
        totalObservations: totalSpans,
        totalTraces: spanIdsByTrace.size,
      },
    });

    // Pass 2: stream again and ingest in span batches.
    let batch: JsonlSpanRecord[] = [];
    let sinceProgressUpdate = 0;

    const flushBatch = async () => {
      if (batch.length === 0) return;
      assertNotCancelled(database, appJobId, signal);
      const records = batch;
      batch = [];

      const outcome = ingestRecordBatch(database, records, context, spanIdsByTrace);
      counters.failedTraces += outcome.failedTraces;
      counters.importedSpans += outcome.acceptedSpanCount;
      counters.processedSpans += records.length;
      for (const id of outcome.importedTraceIds) counters.importedTraceIds.add(id);

      sinceProgressUpdate += records.length;
      if (sinceProgressUpdate >= PROGRESS_UPDATE_SPAN_INTERVAL) {
        sinceProgressUpdate = 0;
        await publishCounters();
      }
    };

    const publishCounters = async (patch: Record<string, unknown> = {}) => {
      const lastRecord = batch.at(-1);
      await updateProgress({
        database,
        job,
        live,
        patch: {
          currentTraceId: lastRecord
            ? normalizeHexId(lastRecord.trace_id, 32)
            : null,
          currentTraceName: lastRecord?.name ?? null,
          failedTraces: counters.failedTraces,
          importedObservations: counters.importedSpans,
          importedTraces: counters.importedTraceIds.size,
          progress: progressFor(counters.processedSpans, totalSpans),
          ...patch,
        },
      });
    };

    for await (const { record } of streamJsonlSpans(appJob.filePath)) {
      batch.push(record);
      if (batch.length >= INGEST_BATCH_SPAN_LIMIT) {
        await flushBatch();
      }
    }
    await flushBatch();
    await publishCounters();

    const complete = updateFileImportJob(database.sqlite, appJobId, {
      currentTraceId: null,
      currentTraceName: null,
      finishedAt: Date.now(),
      progress: 100,
      status: "completed",
    });
    await job.updateProgress(100, "Import complete");
    publishFileImportJob(live, complete);
    return { appJobId, importedTraces: counters.importedTraceIds.size };
  } catch (error) {
    if (
      error instanceof ImportCancelledError ||
      isCancelled(database, appJobId, signal) ||
      isAbortError(error)
    ) {
      await markCancelled({ database, job, live });
      return { appJobId, cancelled: true };
    }
    const message = error instanceof Error ? error.message : "Import failed";
    const failed = updateFileImportJob(database.sqlite, appJobId, {
      errorMessage: message,
      finishedAt: Date.now(),
      status: "failed",
    });
    publishFileImportJob(live, failed);
    throw error;
  }
}

class ImportCancelledError extends Error {
  constructor() {
    super("Import cancelled");
    this.name = "ImportCancelledError";
  }
}

function ingestRecordBatch(
  database: DatabaseHandle,
  records: JsonlSpanRecord[],
  context: FileImportContext,
  spanIdsByTrace: Map<string, Set<string>>,
) {
  const traceIdsOf = (batch: JsonlSpanRecord[]) =>
    [...new Set(batch.map((record) => normalizeHexId(record.trace_id, 32)))].filter(
      (id): id is string => Boolean(id),
    );

  try {
    const result = ingestOtlpPayload(database, records, context, spanIdsByTrace);
    return {
      acceptedSpanCount: result.acceptedSpanCount,
      failedTraces: 0,
      importedTraceIds: traceIdsOf(records),
    };
  } catch {
    // Retry trace by trace so one bad trace doesn't sink the whole batch.
    const byTrace = new Map<string, JsonlSpanRecord[]>();
    for (const record of records) {
      const traceId = normalizeHexId(record.trace_id, 32) ?? "";
      const group = byTrace.get(traceId) ?? [];
      group.push(record);
      byTrace.set(traceId, group);
    }
    let acceptedSpanCount = 0;
    let failedTraces = 0;
    const importedTraceIds: string[] = [];
    for (const [traceId, group] of byTrace) {
      try {
        const result = ingestOtlpPayload(database, group, context, spanIdsByTrace);
        acceptedSpanCount += result.acceptedSpanCount;
        importedTraceIds.push(traceId);
      } catch {
        failedTraces += 1;
      }
    }
    return { acceptedSpanCount, failedTraces, importedTraceIds };
  }
}

function ingestOtlpPayload(
  database: DatabaseHandle,
  records: JsonlSpanRecord[],
  context: FileImportContext,
  spanIdsByTrace: Map<string, Set<string>>,
) {
  const body = JSON.stringify(jsonlSpansToOtlp(records, context, spanIdsByTrace));
  return ingestTelemetry(
    database.sqlite,
    {
      body,
      contentEncoding: "file-import",
      searchMode: "compact",
      sizeBytes: Buffer.byteLength(body),
    },
  );
}

async function updateProgress(input: {
  database: DatabaseHandle;
  job: Job<ImportJobData>;
  live: LiveEventStore;
  patch: Parameters<typeof updateFileImportJob>[2];
}) {
  await renewJobLock(input.job);
  const updated = updateFileImportJob(
    input.database.sqlite,
    input.job.data.appJobId,
    input.patch,
  );
  if (input.patch.progress != null) {
    await input.job.updateProgress(
      input.patch.progress,
      updated.currentTraceName ?? updated.status,
    );
  }
  publishFileImportJob(input.live, updated);
}

async function renewJobLock(job: Job<ImportJobData>) {
  const lockableJob = job as Job<ImportJobData> & { token?: string };
  if (!lockableJob.token) return;
  await job.extendLock(lockableJob.token, 10 * 60 * 1000).catch(() => {});
}

async function markCancelled(input: {
  database: DatabaseHandle;
  job: Job<ImportJobData>;
  live: LiveEventStore;
}) {
  const updated = updateFileImportJob(
    input.database.sqlite,
    input.job.data.appJobId,
    {
      errorMessage: "Import cancelled by user.",
      finishedAt: Date.now(),
      status: "cancelled",
    },
  );
  await input.job.updateProgress(updated.progress, "Import cancelled");
  publishFileImportJob(input.live, updated);
}

function isCancelled(
  database: DatabaseHandle,
  appJobId: string,
  signal: AbortSignal | undefined,
) {
  return signal?.aborted || isFileImportCancelled(database.sqlite, appJobId);
}

function assertNotCancelled(
  database: DatabaseHandle,
  appJobId: string,
  signal: AbortSignal | undefined,
) {
  if (isCancelled(database, appJobId, signal)) {
    throw new ImportCancelledError();
  }
}

function progressFor(processedSpans: number, totalSpans: number) {
  if (totalSpans <= 0) return processedSpans > 0 ? 95 : 5;
  return Math.min(99, Math.max(5, Math.floor((processedSpans / totalSpans) * 100)));
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function queueDataPath(databasePath: string) {
  return databasePath === ":memory:"
    ? ":memory:"
    : `${databasePath}.fileimport.bunqueue.sqlite`;
}
