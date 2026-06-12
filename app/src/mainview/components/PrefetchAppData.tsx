import { useEffect } from "react";

import { trpc } from "~/trpc";
import { startDateForRange } from "~/lib/format";
import { TELEMETRY_FACET_IDS } from "~/tracing/filters";
import { RUN_CONFIG_FACET_IDS } from "~/halo/RunConfigDialog";

/**
 * Warms the query cache for every main view as soon as the app boots, so
 * navigating between pages never flashes loading states. Inputs must match
 * the pages' query inputs exactly — that's what makes the cache keys hit.
 */
export function PrefetchAppData() {
  const utils = trpc.useUtils();

  useEffect(() => {
    const filters = { startDate: startDateForRange("24h") };

    // Traces page (both view modes).
    void utils.telemetry.info.prefetch();
    void utils.traces.facets.prefetch({ facetIds: TELEMETRY_FACET_IDS });
    void utils.traces.list.prefetch({
      filters,
      limit: 75,
      sortBy: "start_time",
      sortOrder: "desc",
    });
    void utils.sessions.facets.prefetch({ facetIds: TELEMETRY_FACET_IDS });
    void utils.sessions.list.prefetch({
      filters,
      limit: 75,
      sortBy: "last_activity",
      sortOrder: "desc",
    });

    // Analysis page + Run Analysis dialog + Settings.
    void utils.halo.runs.list.prefetch({ limit: 100 });
    void utils.halo.engine.status.prefetch();
    void utils.halo.providers.list.prefetch();
    void utils.sessions.facets.prefetch({ facetIds: RUN_CONFIG_FACET_IDS });
    void utils.halo.runs.preview.prefetch({
      filters,
      targetType: "session_group",
    });

    // Imports page + Langfuse/Phoenix dialogs.
    void utils.langfuse.imports.list.prefetch({ limit: 100 });
    void utils.langfuse.connections.list.prefetch();
    void utils.phoenix.imports.list.prefetch({ limit: 100 });
    void utils.phoenix.connections.list.prefetch();
    void utils.fileImport.imports.list.prefetch({ limit: 100 });
  }, [utils]);

  return null;
}
