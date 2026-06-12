export type FileImportStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Counts shown on the import dialog's preview step, from one streaming pass. */
export type FileImportPreview = {
  earliestTimestamp: string | null;
  latestTimestamp: string | null;
  fileName: string;
  fileSizeBytes: number;
  invalidLines: number;
  observations: number;
  serviceNames: string[];
  sessions: number;
  traces: number;
};

export type FileImportJob = {
  id: string;
  bunqueueJobId: string | null;
  currentTraceId: string | null;
  currentTraceName: string | null;
  errorMessage: string | null;
  failedTraces: number;
  fileName: string;
  filePath: string;
  fileSizeBytes: number;
  finishedAt: string | null;
  importedObservations: number;
  importedTraces: number;
  progress: number;
  skippedLines: number;
  startedAt: string | null;
  status: FileImportStatus;
  totalObservations: number;
  totalTraces: number;
  createdAt: string;
  updatedAt: string;
};

/** One JSONL line: a single span in HALO's export shape. */
export type JsonlSpanRecord = {
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  trace_state?: string | null;
  name?: string | null;
  kind?: string | null;
  start_time: string;
  end_time?: string | null;
  status?: { code?: string | null; message?: string | null } | null;
  resource?: { attributes?: Record<string, unknown> | null } | null;
  scope?: { name?: string | null; version?: string | null } | null;
  attributes?: Record<string, unknown> | null;
  events?: Array<{
    name?: string | null;
    timestamp?: string | null;
    attributes?: Record<string, unknown> | null;
  }> | null;
  links?: Array<{
    traceId?: string | null;
    spanId?: string | null;
    traceState?: string | null;
    attributes?: Record<string, unknown> | null;
  }> | null;
};
