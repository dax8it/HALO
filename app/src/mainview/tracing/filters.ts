import type { FacetId } from "../../server/telemetry/types";

export type StatusFilter = "all" | "ok" | "error";
export type ScopeFilter = "all" | "root" | "entrypoint";
export type SourceFilter = "all" | "local" | "langfuse" | "phoenix" | "file";
export type TraceMonitorViewMode = "traces" | "sessions";

/**
 * Shared facet-id list for the trace/session views. Prefetchers must pass the
 * exact same input as the pages for cache keys to match.
 */
export const TELEMETRY_FACET_IDS: FacetId[] = [
  "agent_name",
  "llm_model_name",
  "observation_kind",
  "service_name",
  "source",
  "status",
];
