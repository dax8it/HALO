import { useEffect, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Ban,
  DownloadCloud,
  FileUp,
  Layers3,
  Loader2,
  MessageSquare,
  Play,
  RotateCcw,
} from "lucide-react";

import { Button, Dialog, Input, cn, toast } from "~/lib/ui";
import { trpc } from "~/trpc";
import { StatTile } from "~/components/StatTile";
import { isDesktopShell, pickImportFile } from "~/desktop/desktopBridge";
import type { FileImportPreview } from "../../../server/fileimport/types";
import { ImportProgressStep } from "../langfuse/ImportProgressStep";

type DialogStep = "choose" | "preview" | "import" | "done";

export function FileImportDialog({
  onImported,
  onOpenChange,
  open,
}: {
  onImported: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const utils = trpc.useUtils();
  const [step, setStep] = useState<DialogStep>("choose");
  const [filePath, setFilePath] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const desktop = isDesktopShell();
  const infoQuery = trpc.telemetry.info.useQuery(undefined, { enabled: open });

  const jobsQuery = trpc.fileImport.imports.list.useQuery(
    { limit: 8 },
    { enabled: open },
  );
  const activeJobQuery = trpc.fileImport.imports.get.useQuery(
    { jobId: activeJobId ?? "" },
    {
      enabled: open && Boolean(activeJobId),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "queued" || status === "running" ? 1_500 : false;
      },
    },
  );
  const preview = trpc.fileImport.imports.preview.useQuery(
    { filePath },
    {
      enabled: open && step === "preview" && Boolean(filePath),
      placeholderData: keepPreviousData,
      retry: false,
      staleTime: 5 * 60_000,
    },
  );

  const startImport = trpc.fileImport.imports.start.useMutation({
    onError(error) {
      toast.error({
        title: "Could not start import",
        description: error.message,
      });
    },
    async onSuccess(job) {
      setActiveJobId(job.id);
      setStep("import");
      await utils.fileImport.imports.list.invalidate();
      toast.info({
        title: "File import queued",
        description: "The import will keep running if this dialog is closed.",
      });
    },
  });

  const cancelImport = trpc.fileImport.imports.cancel.useMutation({
    async onSuccess(job) {
      await utils.fileImport.imports.get.invalidate({ jobId: job.id });
      await utils.fileImport.imports.list.invalidate();
      toast.warning({
        title: "Import cancelled",
        description: "The current file import has been stopped.",
      });
    },
  });

  trpc.live.importJob.useSubscription(
    { jobId: activeJobId ?? "" },
    {
      enabled: open && Boolean(activeJobId),
      onData(eventEnvelope) {
        const event = eventEnvelope.data;
        if (event.payload.type !== "import.job.updated") return;
        const snapshot = event.payload.job;
        utils.fileImport.imports.get.setData(
          { jobId: snapshot.id },
          (current) =>
            current
              ? {
                  ...current,
                  ...snapshot,
                  status: snapshot.status as typeof current.status,
                }
              : current,
        );
        void utils.fileImport.imports.list.invalidate();
        if (snapshot.status === "completed") {
          setStep("done");
          onImported();
        }
      },
    },
  );

  const latestJob = activeJobQuery.data;

  useEffect(() => {
    if (!open || activeJobId) return;
    const running = jobsQuery.data?.find((job) =>
      ["queued", "running"].includes(job.status),
    );
    if (running) {
      setActiveJobId(running.id);
      setStep("import");
    }
  }, [activeJobId, jobsQuery.data, open]);

  useEffect(() => {
    if (!latestJob || !activeJobId) return;
    if (latestJob.status === "completed") {
      setStep("done");
      onImported();
    }
  }, [activeJobId, latestJob, onImported]);

  // Closing the dialog after an import has finished resets the wizard, so the
  // next open starts fresh instead of replaying the previous run. A still
  // running import keeps its state so reopening returns to the progress view.
  useEffect(() => {
    if (open || step === "choose" || step === "preview") return;
    const active =
      latestJob?.status === "queued" || latestJob?.status === "running";
    if (active) return;
    setActiveJobId(null);
    setFilePath("");
    setManualPath("");
    setStep("choose");
  }, [latestJob, open, step]);

  const chooseNativeFile = async () => {
    const path = await pickImportFile();
    if (!path) return;
    setFilePath(path);
    setStep("preview");
  };

  const useManualPath = () => {
    const trimmed = manualPath.trim();
    if (!trimmed) return;
    setFilePath(trimmed);
    setStep("preview");
  };

  // Dropped/selected File objects carry no usable local path in the webview
  // or browser, so the bytes stream to the server, which stores a copy and
  // returns the path the import runs against.
  const uploadFile = async (file: File) => {
    const ingestUrl = infoQuery.data?.ingestUrl;
    if (!ingestUrl) {
      toast.error({
        title: "Could not upload file",
        description: "The local HALO server is not reachable yet. Try again.",
      });
      return;
    }
    setUploading(true);
    try {
      const response = await fetch(new URL("/v1/import/upload", ingestUrl), {
        body: file,
        headers: { "x-halo-file-name": file.name },
        method: "POST",
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail || `Upload failed with HTTP ${response.status}`);
      }
      const result = (await response.json()) as { path: string };
      setFilePath(result.path);
      setStep("preview");
    } catch (error) {
      toast.error({
        title: "Could not upload file",
        description:
          error instanceof Error ? error.message : "The upload failed.",
      });
    } finally {
      setUploading(false);
    }
  };

  const beginImport = () => {
    if (!filePath) return;
    startImport.mutate({ filePath });
  };

  const canStartImport =
    Boolean(filePath) &&
    !startImport.isPending &&
    !preview.isError &&
    Boolean(preview.data) &&
    preview.data?.traces !== 0;
  const jobActive =
    latestJob?.status === "queued" || latestJob?.status === "running";
  const jobFailed =
    latestJob?.status === "failed" || latestJob?.status === "interrupted";

  return (
    <Dialog
      className="!w-[min(800px,92vw)] !max-w-[92vw] sm:!max-w-[800px] md:!w-[800px]"
      dialogDescription="Bring traces from a JSONL export into the local HALO timeline."
      dialogTitle={
        <span className="flex items-center gap-2">
          <DownloadCloud className="h-5 w-5 text-detail-brand" />
          Import Data
        </span>
      }
      maxWidth={800}
      footer={
        <div className="flex items-center justify-between gap-3 border-t border-subtle px-6 py-4">
          <StepRail failed={jobFailed} step={step} />
          <div className="flex items-center gap-2">
            {step === "choose" ? (
              <Button onClick={() => onOpenChange(false)} variant="ghost">
                Close
              </Button>
            ) : null}
            {step === "preview" ? (
              <>
                <Button onClick={() => setStep("choose")} variant="secondary">
                  Back
                </Button>
                <Button disabled={!canStartImport} onClick={beginImport}>
                  {startImport.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-2 h-4 w-4" />
                  )}
                  Start import
                </Button>
              </>
            ) : null}
            {step === "import" || step === "done" ? (
              jobActive ? (
                <Button
                  disabled={cancelImport.isPending || !latestJob}
                  onClick={() => {
                    if (latestJob) cancelImport.mutate({ jobId: latestJob.id });
                  }}
                  variant="secondary"
                >
                  <Ban className="mr-2 h-4 w-4" />
                  Cancel import
                </Button>
              ) : (
                <>
                  <Button onClick={() => onOpenChange(false)} variant="ghost">
                    Close
                  </Button>
                  <Button
                    onClick={() => {
                      setActiveJobId(null);
                      setStep("choose");
                    }}
                    variant={jobFailed ? "secondary" : "default"}
                  >
                    Start another import
                  </Button>
                  {jobFailed && latestJob ? (
                    <Button
                      disabled={startImport.isPending}
                      onClick={() =>
                        startImport.mutate({ filePath: latestJob.filePath })
                      }
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      Retry import
                    </Button>
                  ) : null}
                </>
              )
            ) : null}
          </div>
        </div>
      }
      hideConfirmButton
      onConfirm={() => undefined}
      onOpenChange={onOpenChange}
      open={open}
    >
      <div className="space-y-5">
        {step === "choose" ? (
          <ChooseStep
            desktop={desktop}
            manualPath={manualPath}
            onChooseNativeFile={() => void chooseNativeFile()}
            onManualPathChange={setManualPath}
            onUploadFile={(file) => void uploadFile(file)}
            onUseManualPath={useManualPath}
            uploading={uploading}
          />
        ) : null}

        {step === "preview" ? (
          <PreviewStep
            error={preview.error?.message ?? null}
            fileName={fileNameOf(filePath)}
            loading={preview.isLoading}
            preview={preview.data}
          />
        ) : null}

        {step === "import" || step === "done" ? (
          <ImportProgressStep job={latestJob} providerLabel="the file" />
        ) : null}
      </div>
    </Dialog>
  );
}

function ChooseStep({
  desktop,
  manualPath,
  onChooseNativeFile,
  onManualPathChange,
  onUploadFile,
  onUseManualPath,
  uploading,
}: {
  desktop: boolean;
  manualPath: string;
  onChooseNativeFile: () => void;
  onManualPathChange: (value: string) => void;
  onUploadFile: (file: File) => void;
  onUseManualPath: () => void;
  uploading: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSelectClick = () => {
    if (uploading) return;
    // The desktop shell has a real file picker that yields a path, so the
    // import can read the file in place instead of copying it.
    if (desktop) {
      onChooseNativeFile();
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    const file = event.dataTransfer.files?.[0];
    if (file) onUploadFile(file);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-subtle bg-background-muted p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <FileUp className="h-4 w-4" />
          JSONL trace export
        </div>
        <p className="text-sm text-muted-foreground">
          Import a .jsonl file with one span per line, the format HALO and
          Catalyst trace exports use. Traces, sessions, models, and token
          counts come through exactly as exported.
        </p>
      </div>

      <input
        accept=".jsonl,.json,application/jsonl,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onUploadFile(file);
        }}
        ref={fileInputRef}
        type="file"
      />

      <button
        className={cn(
          "grid min-h-44 w-full place-items-center rounded-[18px] border border-dashed border-border/80 bg-card p-6 text-center transition hover:border-detail-brand/50 hover:bg-card-hover/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          dragging && "border-detail-brand bg-detail-brand/5",
          uploading && "pointer-events-none opacity-70",
        )}
        onClick={handleSelectClick}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDrop={handleDrop}
        type="button"
      >
        <span className="space-y-2">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-detail-brand/10 text-detail-brand">
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <FileUp className="h-5 w-5" />
            )}
          </span>
          <span className="block text-base font-medium">
            {uploading
              ? "Uploading file…"
              : dragging
                ? "Drop the file to import it"
                : "Choose a JSONL file…"}
          </span>
          <span className="block text-sm text-muted-foreground">
            {uploading
              ? "Sending the file to the local HALO server"
              : "Click to browse, or drag a file here"}
          </span>
        </span>
      </button>

      <div className="space-y-2">
        <div className="flex items-end gap-2">
          <Input
            className="flex-1"
            label="Or enter a file path"
            onChange={(event) => onManualPathChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onUseManualPath();
            }}
            placeholder="/path/to/traces.jsonl"
            value={manualPath}
          />
          <Button
            disabled={!manualPath.trim() || uploading}
            onClick={onUseManualPath}
            variant="secondary"
          >
            Use path
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Pointing at a path imports the file in place without copying it.
        </p>
      </div>
    </div>
  );
}

function PreviewStep({
  error,
  fileName,
  loading,
  preview,
}: {
  error: string | null;
  fileName: string;
  loading: boolean;
  preview: FileImportPreview | undefined;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-subtle bg-background-muted px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FileUp className="h-4 w-4 shrink-0 text-detail-brand" />
          <p className="truncate text-sm font-medium">{preview?.fileName ?? fileName}</p>
        </div>
        {preview ? (
          <p className="shrink-0 text-xs text-muted-foreground">
            {formatBytes(preview.fileSizeBytes)}
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-md border border-detail-failure/30 bg-detail-failure/10 p-3">
          <p className="text-sm text-detail-failure">{error}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Go back and choose a different file, or check that the file is a
            JSONL trace export.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <StatTile
              detail={matchedRangeLabel(preview) ?? "in this file"}
              icon={<Activity />}
              label="Traces"
              loading={loading}
              value={preview ? preview.traces.toLocaleString() : "—"}
            />
            <StatTile
              detail="distinct sessions"
              icon={<MessageSquare />}
              label="Sessions"
              loading={loading}
              value={preview ? preview.sessions.toLocaleString() : "—"}
            />
            <StatTile
              detail={serviceDetail(preview)}
              icon={<Layers3 />}
              label="Spans"
              loading={loading}
              value={preview ? preview.observations.toLocaleString() : "—"}
            />
          </div>
          {preview && preview.invalidLines > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-detail-warning/40 bg-detail-warning/10 px-3 py-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-detail-warning" />
              <p className="text-sm text-muted-foreground">
                {preview.invalidLines.toLocaleString()}{" "}
                {preview.invalidLines === 1 ? "line" : "lines"} could not be
                parsed and will be skipped.
              </p>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {loading
              ? "Scanning the file…"
              : "Counts are exact. The whole file was scanned and everything above will be imported."}
          </p>
        </div>
      )}
    </div>
  );
}

function StepRail({ failed, step }: { failed?: boolean; step: DialogStep }) {
  const steps: DialogStep[] = ["choose", "preview", "import", "done"];
  const activeIndex = steps.indexOf(step);
  return (
    <div className="hidden items-center gap-2 md:flex">
      {steps.map((item, index) => {
        const failedStep = failed && item === "import" && index <= activeIndex;
        return (
          <div className="flex items-center gap-2" key={item}>
            <span
              className={cn(
                "grid h-6 min-w-6 place-items-center rounded-full border text-[11px]",
                failedStep
                  ? "border-detail-failure bg-detail-failure/15 text-detail-failure"
                  : index <= activeIndex
                    ? "border-detail-brand bg-detail-brand/15 text-detail-brand"
                    : "border-subtle text-muted-foreground",
              )}
            >
              {index + 1}
            </span>
            <span className="text-xs capitalize text-muted-foreground">{item}</span>
            {index < steps.length - 1 ? (
              <span className="h-px w-5 bg-border/50" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** "May 12 – Jun 11" span of the spans in the file. */
function matchedRangeLabel(preview: FileImportPreview | undefined) {
  if (!preview?.earliestTimestamp || !preview.latestTimestamp) return null;
  const format = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    });
  const earliest = format(preview.earliestTimestamp);
  const latest = format(preview.latestTimestamp);
  return earliest === latest ? earliest : `${earliest} – ${latest}`;
}

function serviceDetail(preview: FileImportPreview | undefined) {
  if (!preview || preview.serviceNames.length === 0) return "in this file";
  if (preview.serviceNames.length === 1) return preview.serviceNames[0];
  return `${preview.serviceNames.length} services`;
}

function fileNameOf(path: string) {
  return path.split("/").at(-1) ?? path;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
