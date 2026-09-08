#!/usr/bin/env node
/**
 * HTTP entrypoint: serves MCP over the Streamable HTTP transport so clients on
 * other machines can use this server. Intended to run on a host behind TLS
 * (a reverse proxy, or a private network such as Tailscale).
 *
 * Every request is authenticated with a shared bearer secret. The server holds
 * a Keap token that can read the whole CRM, so it never starts without one.
 *
 * The transport runs in stateless mode: each request gets its own transport
 * and server instance and nothing is kept between calls. That keeps the
 * process restart-safe and lets several replicas sit behind one proxy. The
 * Keap client, with its cache and rate limiter, is the one shared object.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadConfig, loadHttpConfig, type HttpConfig } from "./config.js";
import { KeapClient } from "./client.js";
import { endpoints } from "./catalog.js";
import { createServer } from "./server.js";

const MAX_BODY_BYTES = 1_000_000;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  json(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

function authorised(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  return presented.length === wanted.length && timingSafeEqual(presented, wanted);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const http: HttpConfig = loadHttpConfig();

  if (!http.authToken) {
    console.error(
      "keapmcp-http: refusing to start without KEAP_MCP_AUTH_TOKEN. " +
        "Generate one with `openssl rand -hex 32` and put it in .env; clients send it as " +
        "`Authorization: Bearer <token>`.",
    );
    process.exit(1);
  }
  if (!config.token) {
    console.error("keapmcp-http: no KEAP_PAT found. Add it to .env; tools will report this too.");
  }

  const client = new KeapClient(config);

  const listener = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") {
      json(res, 200, { ok: true, service: "keapmcp", read_endpoints: endpoints.length });
      return;
    }

    if (url.pathname !== http.path) {
      json(res, 404, { error: "not found" });
      return;
    }

    if (!authorised(req, http.authToken)) {
      rpcError(res, 401, -32001, "Unauthorized: send `Authorization: Bearer <KEAP_MCP_AUTH_TOKEN>`", {
        "www-authenticate": 'Bearer realm="keapmcp"',
      });
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode has no standalone notification stream and no sessions to
      // delete, so GET and DELETE have nothing to serve.
      rpcError(res, 405, -32000, "Method not allowed: this server accepts POST only");
      return;
    }

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      rpcError(res, 413, -32000, "Request body too large");
      return;
    }

    const server = createServer(client, config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("keapmcp-http: request failed:", error);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
      else res.end();
    }
  });

  // Long reports stream progress for tens of seconds; do not cut them off.
  listener.requestTimeout = 0;
  listener.headersTimeout = 60_000;

  listener.listen(http.port, http.host, () => {
    console.error(
      `keapmcp-http listening on http://${http.host}:${http.port}${http.path} — ` +
        `${endpoints.length} Keap read endpoints available`,
    );
  });

  const shutdown = (signal: string) => {
    console.error(`keapmcp-http: ${signal} received, shutting down`);
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("keapmcp-http failed to start:", error);
  process.exit(1);
});
