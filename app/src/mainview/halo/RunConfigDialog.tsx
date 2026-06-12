import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Activity, Layers3, Loader2, MessageSquare, Play, X } from "lucide-react";

import {
  AlertWarning,
  Badge,
  Button,
  Dialog,
  Input,
  Textarea,
  cn,
  toast,
} from "~/lib/ui";
import { trpc } from "~/trpc";
import { FilterSelect } from "~/components/FilterSelect";
import { StatTile } from "~/components/StatTile";
import {
  startDateForRange,
  toFacetOptions,
  type DateRange,
} from "~/lib/format";
import type { HaloRun, HaloRunTargetType } from "../../server/halo/types";
import type { FacetId, TelemetryFilters } from "../../server/telemetry/types";

type StatusFilter = "all" | "ok" | "error";
type SourceFilter = "all" | "local" | "langfuse" | "phoenix" | "file";

const DEFAULT_PROMPT =
  "Analyze these traces. Identify the most important failures, latency bottlenecks, confusing tool behavior, and concrete improvements for the developer.";

/** Exported so PrefetchAppData can warm the same cache keys. */
export const RUN_CONFIG_FACET_IDS: FacetId[] = [
  "agent_name",
  "llm_model_name",
  "service_name",
  "source",
  "status",
];

export type RunConfigInitialValues = {
  /** Verbatim filters copied from an existing run; bypasses the dropdowns. */
  filters?: TelemetryFilters;
  filtersSourceTitle?: string;
  maxDepth?: number;
  maxParallel?: number;
  maxTurns?: number;
  prompt?: string;
  providerId?: string;
  targetType?: HaloRunTargetType;
  title?: string;
};

/** Configure and kick off a HALO run. Opens fresh or prefilled from "Re-run with changes". */
export function RunConfigDialog({
  initialValues,
  onOpenChange,
  onStarted,
  open,
}: {
  initialValues?: RunConfigInitialValues;
  onOpenChange: (open: boolean) => void;
  onStarted: (run: HaloRun) => void;
  open: boolean;
}) {
  const utils = trpc.useUtils();
  const [targetType, setTargetType] = useState<HaloRunTargetType>("session_group");
  const [dateRange, setDateRange] = useState<DateRange>("24h");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [serviceName, setServiceName] = useState("all");
  const [agentName, setAgentName] = useState("all");
  const [modelName, setModelName] = useState("all");
  const [providerId, setProviderId] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [maxDepth, setMaxDepth] = useState(1);
  const [maxTurns, setMaxTurns] = useState(8);
  const [maxParallel, setMaxParallel] = useState(2);
  const [filtersOverride, setFiltersOverride] = useState<{
    filters: TelemetryFilters;
    sourceTitle: string;
  } | null>(null);
  const deferredPrompt = useDeferredValue(prompt);

  // Re-seed the form whenever the dialog opens (fresh or prefilled).
  useEffect(() => {
    if (!open) return;
    setTargetType(initialValues?.targetType ?? "session_group");
    setDateRange("24h");
    setStatus("all");
    setSource("all");
    setServiceName("all");
    setAgentName("all");
    setModelName("all");
    setProviderId(initialValues?.providerId ?? "");
    setTitle(initialValues?.title ?? "");
    setPrompt(initialValues?.prompt ?? DEFAULT_PROMPT);
    setMaxDepth(initialValues?.maxDepth ?? 1);
    setMaxTurns(initialValues?.maxTurns ?? 8);
    setMaxParallel(initialValues?.maxParallel ?? 2);
    setFiltersOverride(
      initialValues?.filters
        ? {
            filters: initialValues.filters,
            sourceTitle: initialValues.filtersSourceTitle ?? "previous run",
          }
        : null,
    );
  }, [initialValues, open]);

  const filters = useMemo<TelemetryFilters>(() => {
    if (filtersOverride) return filtersOverride.filters;
    return {
      agents: agentName === "all" ? undefined : [agentName],
      llmModelNames: modelName === "all" ? undefined : [modelName],
      serviceNames: serviceName === "all" ? undefined : [serviceName],
      sources: source === "all" ? undefined : [source],
      startDate: startDateForRange(dateRange),
      status: status === "all" ? undefined : status,
    };
  }, [agentName, dateRange, filtersOverride, modelName, serviceName, source, status]);

  const engineQuery = trpc.halo.engine.status.useQuery(undefined, { enabled: open });
  const providersQuery = trpc.halo.providers.list.useQuery(undefined, { enabled: open });
  const sessionFacetsQuery = trpc.sessions.facets.useQuery(
    { facetIds: RUN_CONFIG_FACET_IDS },
    { enabled: open && targetType === "session_group" },
  );
  const traceFacetsQuery = trpc.traces.facets.useQuery(
    { facetIds: RUN_CONFIG_FACET_IDS },
    { enabled: open && targetType === "trace_group" },
  );
  const facets =
    targetType === "session_group" ? sessionFacetsQuery.data : traceFacetsQuery.data;
  const previewQuery = trpc.halo.runs.preview.useQuery(
    { filters, targetType },
    { enabled: open, placeholderData: keepPreviousData },
  );

  // Default to the most recently saved provider so starting a run is
  // one-click when a provider already exists.
  const providers = providersQuery.data ?? [];
  useEffect(() => {
    if (!open || providerId) return;
    const mostRecent = providers[0];
    if (mostRecent) setProviderId(mostRecent.id);
  }, [open, providerId, providers]);

  const startMutation = trpc.halo.runs.start.useMutation({
    async onSuccess(run) {
      toast.success({ title: "HALO run queued" });
      onOpenChange(false);
      await utils.halo.runs.list.invalidate();
      onStarted(run);
    },
    onError(error) {
      toast.error({ title: "Could not start HALO run", description: error.message });
    },
  });

  const engineInstalled = engineQuery.data?.status === "installed";
  const needsSetup = !engineInstalled || providers.length === 0;
  const canStart =
    Boolean(providerId) &&
    deferredPrompt.trim().length > 0 &&
    previewQuery.data != null &&
    previewQuery.data.spanCount > 0 &&
    engineInstalled;

  return (
    <Dialog
      className="!w-[min(680px,94vw)] !max-w-[94vw] sm:!max-w-[680px] md:!w-[680px]"
      dialogDescription="Pick a filtered group of telemetry, choose a provider, and kick off the analysis."
      dialogTitle={
        <span className="flex items-center gap-2">
          <Play className="h-5 w-5 text-detail-brand" />
          Run Analysis
        </span>
      }
      footer={
        <div className="flex items-center justify-between gap-3 border-t border-subtle px-6 py-4">
          <p className="text-xs text-muted-foreground">
            {previewQuery.data && previewQuery.data.spanCount === 0
              ? "No telemetry matches these filters yet."
              : "Streams results back into this workspace."}
          </p>
          <div className="flex items-center gap-2">
            <Button onClick={() => onOpenChange(false)} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={!canStart || startMutation.isPending}
              onClick={() =>
                startMutation.mutate({
                  filters,
                  maxDepth,
                  maxParallel,
                  maxTurns,
                  prompt,
                  providerId,
                  targetType,
                  title: title || undefined,
                })
              }
            >
              {startMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Start run
            </Button>
          </div>
        </div>
      }
      hideConfirmButton
      maxWidth={680}
      onConfirm={() => undefined}
      onOpenChange={onOpenChange}
      open={open}
    >
      <div className="space-y-5">
        {needsSetup ? (
          <AlertWarning
            content={
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground">
                  {engineInstalled
                    ? "Add a model provider in Settings."
                    : "Install the HALO engine in Settings."}
                </p>
                <Button asChild size="sm" variant="outline">
                  <a href="#/settings">Open Settings</a>
                </Button>
              </div>
            }
            title="HALO needs setup before analysis can run."
          />
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <SegmentButton
            active={targetType === "session_group"}
            label="Session group"
            onClick={() => setTargetType("session_group")}
          />
          <SegmentButton
            active={targetType === "trace_group"}
            label="Trace group"
            onClick={() => setTargetType("trace_group")}
          />
        </div>

        {filtersOverride ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-detail-brand/30 bg-detail-brand/5 px-3 py-2">
            <p className="min-w-0 truncate text-sm">
              <Badge className="mr-2" size="sm" variant="status-brand">
                Copied filters
              </Badge>
              <span className="text-muted-foreground">
                Using the exact filters from “{filtersOverride.sourceTitle}”.
              </span>
            </p>
            <Button onClick={() => setFiltersOverride(null)} size="xs" variant="ghost">
              <X className="mr-1 h-3 w-3" />
              Clear
            </Button>
          </div>
        ) : null}

        <div
          className={cn(
            "grid gap-3 sm:grid-cols-2",
            filtersOverride && "pointer-events-none opacity-50",
          )}
        >
          <FilterSelect
            label="Window"
            onChange={(value) => setDateRange(value as DateRange)}
            options={[
              { label: "Last hour", value: "1h" },
              { label: "Last 24 hours", value: "24h" },
              { label: "Last 7 days", value: "7d" },
              { label: "All time", value: "all" },
            ]}
            value={dateRange}
          />
          <FilterSelect
            label="Status"
            onChange={(value) => setStatus(value as StatusFilter)}
            options={[
              { label: "Any status", value: "all" },
              { label: "OK", value: "ok" },
              { label: "Errors", value: "error" },
            ]}
            value={status}
          />
          <FilterSelect
            label="Source"
            onChange={(value) => setSource(value as SourceFilter)}
            options={toFacetOptions(facets?.categorical.source, "Any source")}
            value={source}
          />
          <FilterSelect
            label="Service"
            onChange={setServiceName}
            options={toFacetOptions(facets?.categorical.service_name, "Any service")}
            value={serviceName}
          />
          <FilterSelect
            label="Agent"
            onChange={setAgentName}
            options={toFacetOptions(facets?.categorical.agent_name, "Any agent")}
            value={agentName}
          />
          <FilterSelect
            label="Model"
            onChange={setModelName}
            options={toFacetOptions(facets?.categorical.llm_model_name, "Any model")}
            value={modelName}
          />
        </div>

        <div className="flex gap-2">
          <StatTile
            icon={<Activity />}
            label="Traces"
            loading={previewQuery.isLoading}
            value={previewQuery.data?.traceCount ?? 0}
          />
          <StatTile
            icon={<MessageSquare />}
            label="Sessions"
            loading={previewQuery.isLoading}
            value={previewQuery.data?.sessionCount ?? 0}
          />
          <StatTile
            icon={<Layers3 />}
            label="Spans"
            loading={previewQuery.isLoading}
            value={previewQuery.data?.spanCount ?? 0}
          />
        </div>
        {previewQuery.data?.warnings.length ? (
          <p className="text-xs text-detail-warning">
            {previewQuery.data.warnings.join(" ")}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <FilterSelect
            label="Provider"
            onChange={setProviderId}
            options={providers.map((provider) => ({
              label: `${provider.name} · ${provider.model}`,
              value: provider.id,
            }))}
            placeholder="Choose provider"
            value={providerId}
          />
          <label className="space-y-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              Title
            </span>
            <Input
              onChange={(event) => setTitle(event.currentTarget.value)}
              placeholder="Optional run title"
              value={title}
            />
          </label>
        </div>

        <label className="space-y-2">
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            Analysis prompt
          </span>
          <Textarea
            className="min-h-28 resize-y"
            onChange={(event) => setPrompt(event.currentTarget.value)}
            value={prompt}
          />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <NumberField label="Depth" min={0} onChange={setMaxDepth} value={maxDepth} />
          <NumberField label="Turns" min={1} onChange={setMaxTurns} value={maxTurns} />
          <NumberField
            label="Parallel"
            min={1}
            onChange={setMaxParallel}
            value={maxParallel}
          />
        </div>
      </div>
    </Dialog>
  );
}

function SegmentButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      className={cn(active && "border-detail-brand/60 text-detail-brand")}
      onClick={onClick}
      type="button"
      variant={active ? "secondary" : "outline"}
    >
      {label}
    </Button>
  );
}

function NumberField({
  label,
  min,
  onChange,
  value,
}: {
  label: string;
  min: number;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <label className="space-y-2">
      <span className="text-xs font-semibold uppercase text-muted-foreground">
        {label}
      </span>
      <Input
        min={min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        type="number"
        value={String(value)}
      />
    </label>
  );
}
