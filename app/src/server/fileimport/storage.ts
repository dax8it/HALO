import type { Database } from "bun:sqlite";
import type { ImportJobSnapshot, LiveEventStore } from "../live/events";
import type { FileImportJob, FileImportStatus } from "./types";

type JobRow = {
  id: string;
  bunqueue_job_id: string | null;
  status: FileImportStatus;
  file_name: string;
  file_path: string;
  file_size_bytes: number;
  progress: number;
  total_traces: number;
  imported_traces: number;
  total_observations: number;
  imported_observations: number;
  failed_traces: number;
  skipped_lines: number;
  error_message: string | null;
  current_trace_id: string | null;
  current_trace_name: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export function createFileImportJob(
  sqlite: Database,
  input: { fileName: string; filePath: string; fileSizeBytes: number },
): FileImportJob {
  const now = Date.now();
  const id = crypto.randomUUID();
  sqlite
    .query(
      `INSERT INTO file_import_jobs (
        id, status, file_name, file_path, file_size_bytes, progress,
        created_at, updated_at
      ) VALUES (?, 'queued', ?, ?, ?, 0, ?, ?)`,
    )
    .run(id, input.fileName, input.filePath, input.fileSizeBytes, now, now);
  const job = getFileImportJob(sqlite, id);
  if (!job) throw new Error("Failed to create file import job");
  return job;
}

export function updateFileImportJob(
  sqlite: Database,
  id: string,
  patch: Partial<{
    bunqueueJobId: string | null;
    currentTraceId: string | null;
    currentTraceName: string | null;
    errorMessage: string | null;
    failedTraces: number;
    finishedAt: number | null;
    importedObservations: number;
    importedTraces: number;
    progress: number;
    skippedLines: number;
    startedAt: number | null;
    status: FileImportStatus;
    totalObservations: number;
    totalTraces: number;
  }>,
): FileImportJob {
  const sets: string[] = ["updated_at = :updatedAt"];
  const params: Record<string, string | number | null> = {
    id,
    updatedAt: Date.now(),
  };

  const add = (column: string, key: keyof typeof patch) => {
    if (!(key in patch)) return;
    sets.push(`${column} = :${String(key)}`);
    params[String(key)] = patch[key] ?? null;
  };

  add("bunqueue_job_id", "bunqueueJobId");
  add("status", "status");
  add("progress", "progress");
  add("total_traces", "totalTraces");
  add("imported_traces", "importedTraces");
  add("total_observations", "totalObservations");
  add("imported_observations", "importedObservations");
  add("failed_traces", "failedTraces");
  add("skipped_lines", "skippedLines");
  add("error_message", "errorMessage");
  add("current_trace_id", "currentTraceId");
  add("current_trace_name", "currentTraceName");
  add("started_at", "startedAt");
  add("finished_at", "finishedAt");

  sqlite
    .query(
      `UPDATE file_import_jobs
       SET ${sets.join(", ")}
       WHERE id = :id`,
    )
    .run(params);

  const job = getFileImportJob(sqlite, id);
  if (!job) throw new Error("File import job not found");
  return job;
}

export function getFileImportJob(
  sqlite: Database,
  id: string,
): FileImportJob | null {
  const row = sqlite
    .query<JobRow, [string]>(
      `SELECT *
       FROM file_import_jobs
       WHERE id = ?
       LIMIT 1`,
    )
    .get(id);
  return row ? mapImportJob(row) : null;
}

export function listFileImportJobs(sqlite: Database, limit = 20): FileImportJob[] {
  return sqlite
    .query<JobRow, [number]>(
      `SELECT *
       FROM file_import_jobs
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit)
    .map(mapImportJob);
}

export function markInterruptedFileImports(sqlite: Database) {
  const now = Date.now();
  sqlite
    .query(
      `UPDATE file_import_jobs
       SET status = 'interrupted',
           error_message = 'The app stopped before this import finished.',
           finished_at = ?,
           updated_at = ?
       WHERE status IN ('queued', 'running')`,
    )
    .run(now, now);
}

export function isFileImportCancelled(sqlite: Database, id: string) {
  const row = sqlite
    .query<{ status: string }, [string]>(
      `SELECT status
       FROM file_import_jobs
       WHERE id = ?
       LIMIT 1`,
    )
    .get(id);
  return row?.status === "cancelled";
}

export function publishFileImportJob(live: LiveEventStore, job: FileImportJob) {
  live.publish({
    eventType: "import.job.updated",
    payload: {
      job: importJobToSnapshot(job),
      type: "import.job.updated",
    },
  });
}

function importJobToSnapshot(job: FileImportJob): ImportJobSnapshot {
  return {
    bunqueueJobId: job.bunqueueJobId,
    // File imports have no remote connection; the file stands in so shared
    // import UI surfaces still have an id and display name.
    connectionId: job.filePath,
    connectionName: job.fileName,
    currentTraceId: job.currentTraceId,
    currentTraceName: job.currentTraceName,
    errorMessage: job.errorMessage,
    failedTraces: job.failedTraces,
    finishedAt: job.finishedAt,
    id: job.id,
    importedObservations: job.importedObservations,
    importedTraces: job.importedTraces,
    progress: job.progress,
    provider: "file",
    startedAt: job.startedAt,
    status: job.status,
    totalObservations: job.totalObservations,
    totalTraces: job.totalTraces,
    updatedAt: job.updatedAt,
  };
}

function mapImportJob(row: JobRow): FileImportJob {
  return {
    bunqueueJobId: row.bunqueue_job_id,
    createdAt: isoFromMs(row.created_at),
    currentTraceId: row.current_trace_id,
    currentTraceName: row.current_trace_name,
    errorMessage: row.error_message,
    failedTraces: row.failed_traces,
    fileName: row.file_name,
    filePath: row.file_path,
    fileSizeBytes: row.file_size_bytes,
    finishedAt: row.finished_at ? isoFromMs(row.finished_at) : null,
    id: row.id,
    importedObservations: row.imported_observations,
    importedTraces: row.imported_traces,
    progress: row.progress,
    skippedLines: row.skipped_lines,
    startedAt: row.started_at ? isoFromMs(row.started_at) : null,
    status: row.status,
    totalObservations: row.total_observations,
    totalTraces: row.total_traces,
    updatedAt: isoFromMs(row.updated_at),
  };
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}
