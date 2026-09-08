import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Minimal .env loader. The server is normally launched by an MCP client that
 * does not run a shell, so environment variables from the user's profile are
 * not available — reading .env from the project root is the reliable path.
 */
function loadDotEnv(): void {
  for (const file of [".env.local", ".env"]) {
    let raw: string;
    try {
      raw = readFileSync(join(PROJECT_ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue; // real env wins
      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function num(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type AuthMode = "apikey" | "bearer";

export interface Config {
  token: string;
  authMode: AuthMode;
  baseUrl: string;
  maxQps: number;
  timeoutMs: number;
  cacheTtlMs: number;
  /** How many requests may be in flight at once (pacing is separate). */
  maxConcurrency: number;
  /** Records per page when paginating. Smaller pages parallelise better. */
  pageSize: number;
  /** Hard ceiling on records auto-pagination will pull in a single tool call. */
  maxPageFetch: number;
}

export function loadConfig(): Config {
  const token =
    process.env.KEAP_PAT ||
    process.env.KEAP_API_KEY ||
    process.env.KEAP_ACCESS_TOKEN ||
    process.env.KEAP_SERVICE_ACCOUNT_KEY ||
    "";

  const mode = (process.env.KEAP_AUTH_MODE || "apikey").toLowerCase();

  return {
    token,
    authMode: mode === "bearer" ? "bearer" : "apikey",
    baseUrl: (process.env.KEAP_BASE_URL || "https://api.infusionsoft.com/crm").replace(/\/+$/, ""),
    // Keap throttles PATs/SAKs at 10 QPS / 240 QPM / 30k per day. Stay under.
    maxQps: num("KEAP_MAX_QPS", 8),
    timeoutMs: num("KEAP_TIMEOUT_MS", 30_000),
    cacheTtlMs: Number(process.env.KEAP_CACHE_TTL_MS ?? 300_000),
    maxConcurrency: num("KEAP_MAX_CONCURRENCY", 6),
    pageSize: Math.min(1000, num("KEAP_PAGE_SIZE", 500)),
    maxPageFetch: num("KEAP_MAX_PAGE_FETCH", 20_000),
  };
}

export interface HttpConfig {
  /** Interface to listen on. Defaults to loopback; set 0.0.0.0 inside a container. */
  host: string;
  port: number;
  /** URL path that serves MCP, e.g. "/mcp". */
  path: string;
  /** Shared secret clients must present as `Authorization: Bearer <token>`. */
  authToken: string;
}

export function loadHttpConfig(): HttpConfig {
  let path = (process.env.KEAP_MCP_PATH || "/mcp").trim();
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");

  return {
    host: process.env.KEAP_MCP_HOST || "127.0.0.1",
    port: num("KEAP_MCP_PORT", 3000),
    path,
    authToken: (process.env.KEAP_MCP_AUTH_TOKEN || "").trim(),
  };
}
