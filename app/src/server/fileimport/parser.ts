import { basename } from "node:path";
import type {
  OtlpAnyValue,
  OtlpExportTraceServiceRequest,
  OtlpKeyValue,
} from "../telemetry/otlp";
import type { FileImportPreview, JsonlSpanRecord } from "./types";

export class FileImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileImportParseError";
  }
}

export type FileImportContext = {
  fileName?: string;
  importedAt?: Date | number | string;
  importJobId?: string;
};

export type ParsedSpanLine = {
  record: JsonlSpanRecord;
  traceId: string;
};

/**
 * Stream a JSONL export line by line without loading the whole file into
 * memory. Yields parsed spans and reports malformed lines to the callback
 * instead of aborting — real exports routinely contain a few bad rows.
 */
export async function* streamJsonlSpans(
  filePath: string,
  onInvalidLine?: (lineNumber: number, reason: string) => void,
): AsyncGenerator<ParsedSpanLine> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new FileImportParseError(`File not found: ${filePath}`);
  }

  const decoder = new TextDecoder();
  let buffered = "";
  let lineNumber = 0;

  const flushLine = (line: string): ParsedSpanLine | null => {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      onInvalidLine?.(lineNumber, "not valid JSON");
      return null;
    }
    const record = parsed as JsonlSpanRecord;
    const traceId = normalizeHexId(record?.trace_id, 32);
    const spanId = normalizeHexId(record?.span_id, 16);
    if (!traceId || !spanId) {
      onInvalidLine?.(lineNumber, "missing or invalid trace_id/span_id");
      return null;
    }
    if (!Number.isFinite(Date.parse(record.start_time ?? ""))) {
      onInvalidLine?.(lineNumber, "missing or invalid start_time");
      return null;
    }
    return { record, traceId };
  };

  const stream = file.stream();
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      const result = flushLine(line);
      if (result) yield result;
      newlineIndex = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) {
    const result = flushLine(buffered);
    if (result) yield result;
  }
}

/**
 * One streaming pass over the file for the dialog's preview step. Counts are
 * exact, unlike the remote-import previews which sometimes have to estimate.
 */
export async function previewJsonlFile(filePath: string): Promise<FileImportPreview> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new FileImportParseError(`File not found: ${filePath}`);
  }

  const traces = new Set<string>();
  const sessions = new Set<string>();
  const services = new Set<string>();
  let spans = 0;
  let invalidLines = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for await (const { record, traceId } of streamJsonlSpans(filePath, () => {
    invalidLines += 1;
  })) {
    spans += 1;
    traces.add(traceId);
    const attributes = asRecord(record.attributes);
    const sessionId = attributes["session.id"];
    if (typeof sessionId === "string" && sessionId) sessions.add(sessionId);
    const serviceName = asRecord(record.resource?.attributes)["service.name"];
    if (typeof serviceName === "string" && serviceName) services.add(serviceName);
    const start = record.start_time;
    if (earliest == null || start < earliest) earliest = start;
    if (latest == null || start > latest) latest = start;
  }

  if (spans === 0) {
    throw new FileImportParseError(
      invalidLines > 0
        ? `No importable spans found — all ${invalidLines} lines were invalid.`
        : "The file contains no spans.",
    );
  }

  return {
    earliestTimestamp: earliest,
    fileName: basename(filePath),
    fileSizeBytes: file.size,
    invalidLines,
    latestTimestamp: latest,
    observations: spans,
    serviceNames: [...services].sort(),
    sessions: sessions.size,
    traces: traces.size,
  };
}

/**
 * Convert a batch of spans (grouped however the caller likes) into an OTLP
 * payload for ingestTelemetry. Spans are grouped into resourceSpans by their
 * resource attributes so multi-service exports keep service identities.
 */
export function jsonlSpansToOtlp(
  records: JsonlSpanRecord[],
  context: FileImportContext = {},
  knownSpanIds?: Map<string, Set<string>>,
): OtlpExportTraceServiceRequest {
  const groups = new Map<
    string,
    { resourceAttributes: Record<string, unknown>; records: JsonlSpanRecord[] }
  >();
  for (const record of records) {
    const resourceAttributes = asRecord(record.resource?.attributes);
    const key = JSON.stringify(
      Object.entries(resourceAttributes).sort(([a], [b]) => a.localeCompare(b)),
    );
    const group = groups.get(key) ?? { records: [], resourceAttributes };
    group.records.push(record);
    groups.set(key, group);
  }

  // Parent references pointing outside the file's trace would hide spans
  // from HALO's tree view, so only keep parents present in the same trace.
  // Callers that batch one trace across payloads pass the file-wide id map.
  const spanIdsByTrace = knownSpanIds ?? new Map<string, Set<string>>();
  if (!knownSpanIds) {
    for (const record of records) {
      const traceId = normalizeHexId(record.trace_id, 32);
      const spanId = normalizeHexId(record.span_id, 16);
      if (!traceId || !spanId) continue;
      const ids = spanIdsByTrace.get(traceId) ?? new Set<string>();
      ids.add(spanId);
      spanIdsByTrace.set(traceId, ids);
    }
  }

  return {
    resourceSpans: [...groups.values()].map((group) => ({
      resource: {
        attributes: compactAttributes(group.resourceAttributes),
      },
      scopeSpans: [
        {
          scope: {
            name: group.records[0]?.scope?.name || "file-import",
            version: group.records[0]?.scope?.version || "1",
          },
          spans: group.records.map((record) =>
            recordToOtlpSpan(record, spanIdsByTrace, context),
          ),
        },
      ],
    })),
  };
}

function recordToOtlpSpan(
  record: JsonlSpanRecord,
  spanIdsByTrace: Map<string, Set<string>>,
  context: FileImportContext,
) {
  const traceId = normalizeHexId(record.trace_id, 32) ?? "";
  const spanId = normalizeHexId(record.span_id, 16) ?? "";
  const parentId = normalizeHexId(record.parent_span_id, 16);
  const parentSpanId =
    parentId && spanIdsByTrace.get(traceId)?.has(parentId) ? parentId : undefined;

  return {
    attributes: [
      ...compactAttributes(normalizeSpanAttributes(record.attributes)),
      ...compactAttributes({
        "halo.source": "file",
        "halo.source.connection_name": context.fileName,
        "halo.source.import_job_id": context.importJobId,
        "halo.source.imported_at": importedAtIso(context.importedAt),
        "halo.source.trace_id": traceId,
      }),
    ],
    endTimeUnixNano: dateToNano(record.end_time ?? record.start_time),
    events: (record.events ?? []).map((event) => ({
      attributes: compactAttributes(asRecord(event.attributes)),
      name: event.name ?? "event",
      timeUnixNano: dateToNano(event.timestamp ?? record.start_time),
    })),
    kind: record.kind || "SPAN_KIND_INTERNAL",
    links: (record.links ?? []).map((link) => ({
      attributes: compactAttributes(asRecord(link.attributes)),
      spanId: link.spanId ?? undefined,
      traceId: link.traceId ?? undefined,
      traceState: link.traceState ?? undefined,
    })),
    name: record.name || "span",
    parentSpanId,
    spanId,
    startTimeUnixNano: dateToNano(record.start_time),
    status: {
      code: record.status?.code || "STATUS_CODE_UNSET",
      message: record.status?.message ?? "",
    },
    traceId,
    traceState: record.trace_state ?? undefined,
  };
}

/**
 * HALO's own exporter writes numeric attributes under "int."/"double." key
 * prefixes; strip those back to plain keys so round-tripped exports look
 * identical to natively ingested spans. Plain keys pass through untouched.
 */
function normalizeSpanAttributes(
  attributes: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(asRecord(attributes))) {
    if (value == null) continue;
    if (key.startsWith("int.") || key.startsWith("double.")) {
      const plain = key.slice(key.indexOf(".") + 1);
      if (!(plain in normalized)) normalized[plain] = value;
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

export function normalizeHexId(
  value: string | null | undefined,
  length: 16 | 32,
): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  return new RegExp(`^[0-9a-f]{${length}}$`).test(normalized) ? normalized : null;
}

function compactAttributes(values: Record<string, unknown>): OtlpKeyValue[] {
  const attributes: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(values)) {
    const encoded = anyValue(value);
    if (encoded) attributes.push({ key, value: encoded });
  }
  return attributes;
}

function anyValue(value: unknown): OtlpAnyValue | null {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  if (typeof value === "bigint") return { intValue: value.toString() };
  if (Array.isArray(value)) {
    return {
      arrayValue: { values: value.map(anyValue).filter(Boolean) as OtlpAnyValue[] },
    };
  }
  if (typeof value === "string") return { stringValue: value };
  try {
    return { stringValue: JSON.stringify(value) };
  } catch {
    return { stringValue: String(value) };
  }
}

function importedAtIso(value: FileImportContext["importedAt"]): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function dateToNano(value: string | null | undefined): string {
  // Preserve sub-millisecond precision from ISO-nano timestamps like
  // 2026-05-27T21:53:58.757746470Z, which Date.parse would truncate.
  const text = value ?? "";
  const match = text.match(/\.(\d{4,9})Z?$/);
  const parsedMs = Date.parse(text);
  const ms = Number.isFinite(parsedMs) ? parsedMs : Date.now();
  if (!match) return (BigInt(ms) * 1_000_000n).toString();
  const fraction = match[1]!.padEnd(9, "0");
  const wholeSecondsMs = Math.floor(ms / 1000) * 1000;
  return (BigInt(wholeSecondsMs) * 1_000_000n + BigInt(fraction)).toString();
}
