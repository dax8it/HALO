import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { trpcServer } from "@hono/trpc-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { DatabaseHandle } from "./db/client";
import type { HaloRunService } from "./halo/runQueue";
import type { LangfuseImportService } from "./langfuse/importQueue";
import type { PhoenixImportService } from "./phoenix/importQueue";
import type { FileImportService } from "./fileimport/importQueue";
import { createLiveEventStore, type LiveEventStore } from "./live/events";
import { appRouter } from "./router";
import { ingestTelemetry } from "./telemetry/storage";
import { LIVE_WS_URL, TRACE_INGEST_URL } from "./telemetry/types";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
// JSONL trace exports routinely run hundreds of megabytes; uploads stream to
// disk so this cap bounds disk usage, not memory.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function createServerApp(
  database: DatabaseHandle,
  live: LiveEventStore = createLiveEventStore(database.sqlite),
  liveUrl = LIVE_WS_URL,
  langfuseImports?: LangfuseImportService,
  haloRuns?: HaloRunService,
  ingestUrl = TRACE_INGEST_URL,
  phoenixImports?: PhoenixImportService,
  fileImports?: FileImportService,
) {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: [
        "authorization",
        "content-encoding",
        "content-type",
        "x-halo-file-name",
      ],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.get("/health", (c) =>
    c.json({
      dbPath: database.path,
      ok: true,
      service: "halo-canvas-telemetry",
    }),
  );

  const ingestOtlpJson = async (c: Context) => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      throw new HTTPException(415, {
        message:
          "unsupported content-type: HALO currently accepts OTLP/JSON only",
      });
    }

    const { body, contentEncoding, sizeBytes } = await readDecompressedBody(c);
    ingestTelemetry(
      database.sqlite,
      {
        body,
        contentEncoding,
        sizeBytes,
      },
      live,
    );

    c.status(200);
    return c.json({});
  };

  app.post("/v1/traces", ingestOtlpJson);
  app.post("/v1/otel/v1/traces", ingestOtlpJson);
  app.post("/otel/v1/traces", ingestOtlpJson);

  // Receives a dragged/selected JSONL file from the renderer when a local
  // path is not available (browser dev, webview drops). The body streams to
  // a file under the app data dir and the import flow continues path-based.
  app.post("/v1/import/upload", async (c) => {
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      throw new HTTPException(413, {
        message: `file too large: ${declaredLength} bytes exceeds ${MAX_UPLOAD_BYTES}`,
      });
    }
    const fileName = sanitizeUploadFileName(
      c.req.header("x-halo-file-name") ?? "traces.jsonl",
    );
    const uploadDir =
      database.path === ":memory:"
        ? join(tmpdir(), "halo-import-uploads")
        : join(dirname(database.path), "imports");
    // One directory per upload keeps the file's basename intact, so the job
    // and the imports list show the original name instead of a UUID prefix.
    const uploadSubdir = join(uploadDir, crypto.randomUUID());
    mkdirSync(uploadSubdir, { recursive: true });
    const path = join(uploadSubdir, fileName);

    const body = c.req.raw.body;
    if (!body) {
      throw new HTTPException(400, { message: "missing request body" });
    }
    const reader = body.getReader();
    const sink = Bun.file(path).writer();
    let sizeBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sizeBytes += value.byteLength;
        if (sizeBytes > MAX_UPLOAD_BYTES) {
          await reader.cancel();
          throw new HTTPException(413, {
            message: `file too large: exceeds ${MAX_UPLOAD_BYTES} bytes`,
          });
        }
        sink.write(value);
        await sink.flush();
      }
      await sink.end();
    } catch (error) {
      try {
        await sink.end();
      } catch {
        // Already failing; surface the original error below.
      }
      rmSync(uploadSubdir, { force: true, recursive: true });
      throw error;
    }
    return c.json({ fileName, path, sizeBytes });
  });

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      createContext: () => ({
        database,
        haloRuns,
        ingestUrl,
        langfuseImports,
        live,
        liveUrl,
        phoenixImports,
        fileImports,
      }),
    }),
  );

  return app;
}

function sanitizeUploadFileName(value: string) {
  const name = basename(value.trim()).replace(/[^\w.\- ]+/g, "_");
  return name || "traces.jsonl";
}

async function readDecompressedBody(c: {
  req: {
    arrayBuffer(): Promise<ArrayBuffer>;
    header(name: string): string | undefined;
  };
}) {
  const contentEncoding = (c.req.header("content-encoding") ?? "identity").toLowerCase();
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, {
      message: `payload too large: Content-Length ${declaredLength} exceeds ${MAX_BODY_BYTES}`,
    });
  }

  const raw = await c.req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, {
      message: `payload too large: ${raw.byteLength} bytes exceeds ${MAX_BODY_BYTES}`,
    });
  }

  if (contentEncoding === "identity" || contentEncoding === "") {
    return {
      body: new TextDecoder().decode(raw),
      contentEncoding: "identity",
      sizeBytes: raw.byteLength,
    };
  }

  if (contentEncoding !== "gzip") {
    throw new HTTPException(415, {
      message: `unsupported Content-Encoding: ${contentEncoding}`,
    });
  }

  const stream = new Response(raw).body?.pipeThrough(
    new DecompressionStream("gzip"),
  );
  if (!stream) {
    throw new HTTPException(400, { message: "could not read gzip body" });
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HTTPException(413, {
        message: `decompressed payload too large: ${total} bytes exceeds ${MAX_BODY_BYTES}`,
      });
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    body: new TextDecoder().decode(merged),
    contentEncoding,
    sizeBytes: raw.byteLength,
  };
}
