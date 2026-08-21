import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { openDb } from "../db/index.js";
import { executeExtraction } from "../extract/service.js";
import { listMonitorSnapshots } from "../extract/store.js";
import type { ExtractionOutcome } from "../extract/types.js";
import { HostQueue } from "../net/politeness.js";
import { renderExtractionDashboard } from "../report/extraction-dashboard.js";

type Execute = typeof executeExtraction;

export interface ViewServer {
  url: string;
  done: Promise<void>;
  close: () => Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function forbiddenHost(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host?.toLowerCase();
  return host !== `127.0.0.1:${port}` && host !== `localhost:${port}`;
}

export async function startViewServer(
  databasePath: string,
  options: { port?: number; execute?: Execute } = {},
): Promise<ViewServer> {
  const db = openDb(databasePath);
  const token = randomBytes(24).toString("hex");
  const sharedQueue = new HostQueue();
  const execute: Execute = options.execute ?? ((database, monitorId, runOptions) =>
    executeExtraction(database, monitorId, runOptions, { queue: sharedQueue }));
  const inFlight = new Set<string>();
  let actualPort = options.port ?? 4174;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const server = createServer(async (request, response) => {
    if (forbiddenHost(request, actualPort)) {
      response.writeHead(421).end("Misdirected request");
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${actualPort}`);
    if (request.method === "GET" && url.pathname === "/") {
      const html = renderExtractionDashboard(listMonitorSnapshots(db), token, databasePath);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      response.end(html);
      return;
    }
    const match = /^\/api\/(run|test)\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !match) {
      json(response, 404, { error: "Not found" });
      return;
    }
    const origin = request.headers.origin;
    if (request.headers["x-claimrot-token"] !== token
      || (origin && origin !== `http://127.0.0.1:${actualPort}`
        && origin !== `http://localhost:${actualPort}`)) {
      json(response, 403, { error: "Invalid local action token" });
      return;
    }
    const id = decodeURIComponent(match[2]);
    if (inFlight.has(id)) {
      json(response, 409, { error: "This monitor is already running" });
      return;
    }
    inFlight.add(id);
    try {
      const result: ExtractionOutcome = await execute(
        db,
        id,
        { force: true, dryRun: match[1] === "test" },
      );
      json(response, 200, result);
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight.delete(id);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4174, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP address"));
      actualPort = address.port;
      server.off("error", reject);
      resolve();
    });
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
    db.close();
    resolveDone();
  };
  return { url: `http://127.0.0.1:${actualPort}/`, done, close };
}
