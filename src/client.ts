import type { Config } from "./config.js";
import type { Endpoint } from "./catalog.js";
import { normaliseDateBound } from "./analyze.js";

/** Response key meaning "the response body is itself the array". */
export const ROOT_COLLECTION = "$root";

/** Called as pages arrive, so long fetches can report progress to the client. */
export type ProgressFn = (fetched: number, total?: number) => void;

export class KeapError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "KeapError";
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

/**
 * HTTP client for Keap's REST API: paces requests under Keap's published
 * throttle, retries transient failures, caches GETs briefly (analytical
 * questions re-read the same lists repeatedly), and knows how to walk both
 * pagination styles the API uses.
 */
export class KeapClient {
  private recentCalls: number[] = [];
  private cache = new Map<string, CacheEntry>();
  private requestCount = 0;
  private inFlight = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly config: Config) {}

  get stats(): { requests: number; cached: number } {
    return { requests: this.requestCount, cached: this.cache.size };
  }

  private authHeaders(mode = this.config.authMode): Record<string, string> {
    return mode === "bearer"
      ? { Authorization: `Bearer ${this.config.token}` }
      : { "X-Keap-API-Key": this.config.token };
  }

  /** Token-bucket pacing: never exceed maxQps requests in any rolling second. */
  private async throttle(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.recentCalls = this.recentCalls.filter((t) => now - t < 1000);
      if (this.recentCalls.length < this.config.maxQps) {
        this.recentCalls.push(now);
        return;
      }
      const waitMs = 1000 - (now - this.recentCalls[0]) + 5;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  buildUrl(path: string, query: Record<string, unknown> = {}): string {
    const url = new URL(this.config.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Acquire one of a limited number of concurrent request slots. Pacing is
   * enforced separately by `throttle`; this only bounds how many sockets are
   * open at once so a wide fan-out cannot swamp the process.
   */
  private async acquire(): Promise<void> {
    if (this.inFlight < this.config.maxConcurrency) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    this.waiting.shift()?.();
  }

  async request<T = unknown>(url: string, options: { skipCache?: boolean } = {}): Promise<T> {
    // Serve cache hits without occupying a slot.
    if (!options.skipCache && this.config.cacheTtlMs > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value as T;
    }
    await this.acquire();
    try {
      return await this.doRequest<T>(url, options);
    } finally {
      this.release();
    }
  }

  private async doRequest<T>(url: string, options: { skipCache?: boolean }): Promise<T> {
    if (!options.skipCache && this.config.cacheTtlMs > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value as T;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.throttle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        this.requestCount++;
        const response = await fetch(url, {
          headers: { ...this.authHeaders(), Accept: "application/json" },
          signal: controller.signal,
        });

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 500 * 2 ** attempt;
          lastError = new KeapError(
            `Keap returned ${response.status} ${response.statusText}`,
            response.status,
            await safeBody(response),
          );
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 15_000)));
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          const body = await safeBody(response);
          throw new KeapError(describeHttpError(response.status, body, this.config), response.status, body);
        }

        const contentType = response.headers.get("content-type") || "";
        const value = contentType.includes("json")
          ? await response.json()
          : { raw: await response.text() };

        if (this.config.cacheTtlMs > 0) {
          this.cache.set(url, { value, expires: Date.now() + this.config.cacheTtlMs });
        }
        return value as T;
      } catch (error) {
        if (error instanceof KeapError && error.status && error.status < 500 && error.status !== 429) {
          throw error;
        }
        lastError = error;
        if (attempt === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new KeapError(`Request failed: ${String(lastError)}`);
  }

  /** Probe both header styles so setup problems report an actionable answer. */
  async probeAuth(): Promise<{ ok: boolean; workingMode?: "apikey" | "bearer"; detail?: string }> {
    const url = this.buildUrl("/rest/v1/account/profile");
    for (const mode of [this.config.authMode, other(this.config.authMode)] as const) {
      await this.throttle();
      try {
        const response = await fetch(url, {
          headers: { ...this.authHeaders(mode), Accept: "application/json" },
        });
        if (response.ok) return { ok: true, workingMode: mode };
        if (response.status !== 401 && response.status !== 403) {
          return { ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
        }
      } catch (error) {
        return { ok: false, detail: (error as Error).message };
      }
    }
    return { ok: false, detail: "Token rejected (401/403) with both X-Keap-API-Key and Bearer headers." };
  }

  /**
   * Fetch a list endpoint, following pages until `maxItems` is reached.
   * Handles v1 (limit/offset) and v2 (page_size/page_token) transparently.
   */
  async fetchAll(
    endpoint: Endpoint,
    rawQuery: Record<string, unknown>,
    maxItems: number,
    onProgress?: ProgressFn,
  ): Promise<{ items: unknown[]; pagesFetched: number; truncated: boolean; raw?: unknown }> {
    const query = normaliseQuery(endpoint, rawQuery);
    const key = endpoint.collectionKey;
    if (!key) {
      const raw = await this.request(this.buildUrl(resolvePath(endpoint, query), stripPathParams(endpoint, query)));
      return { items: [], pagesFetched: 1, truncated: false, raw };
    }

    const path = resolvePath(endpoint, query);
    const baseQuery = stripPathParams(endpoint, query);
    const pick = (page: unknown): unknown[] =>
      key === ROOT_COLLECTION ? asArray(page) : asArray((page as Record<string, unknown>)?.[key]);
    const items: unknown[] = [];
    let pagesFetched = 0;
    let truncated = false;
    const cap = Math.min(maxItems, this.config.maxPageFetch);

    if (endpoint.pagination === "page_token") {
      let pageToken: string | undefined;
      for (;;) {
        const pageSize = Math.min(1000, Math.max(1, cap - items.length));
        const page = (await this.request(
          this.buildUrl(path, { ...baseQuery, page_size: pageSize, page_token: pageToken }),
        )) as Record<string, unknown>;
        pagesFetched++;
        const batch = pick(page);
        items.push(...batch);
        onProgress?.(items.length, undefined);
        pageToken = typeof page.next_page_token === "string" ? page.next_page_token : undefined;
        if (!pageToken || batch.length === 0) break;
        if (items.length >= cap) {
          truncated = true;
          break;
        }
        if (pagesFetched > 500) {
          truncated = true;
          break;
        }
      }
    } else if (endpoint.pagination === "offset") {
      // v1 list responses carry the total `count`, so all page offsets can be
      // known up front and fetched concurrently — Keap serves parallel pages
      // roughly 3x faster than sequential ones, which is the difference between
      // a report returning and the client timing out. A cheap limit=1 probe buys
      // that count without paying for a full first page.
      const startOffset = Number(baseQuery.offset) || 0;
      const pageSize = Math.min(this.config.pageSize, cap);

      const probe = (await this.request(
        this.buildUrl(path, { ...baseQuery, limit: 1, offset: startOffset }),
      )) as Record<string, unknown>;
      pagesFetched++;
      const total = Number(probe.count);

      if (!Number.isFinite(total)) {
        // No count available: walk pages one at a time until a short page.
        let offset = startOffset;
        for (;;) {
          const limit = Math.min(pageSize, Math.max(1, cap - items.length));
          const page = (await this.request(
            this.buildUrl(path, { ...baseQuery, limit, offset }),
          )) as Record<string, unknown>;
          pagesFetched++;
          const batch = pick(page);
          items.push(...batch);
          onProgress?.(items.length, undefined);
          offset += batch.length;
          if (batch.length < limit) break;
          if (items.length >= cap || pagesFetched > 500) {
            truncated = true;
            break;
          }
        }
      } else {
        const available = Math.max(0, total - startOffset);
        const wanted = Math.min(cap, available);
        truncated = available > cap;

        const offsets: number[] = [];
        for (let taken = 0; taken < wanted; taken += pageSize) {
          offsets.push(startOffset + taken);
        }

        const pages = await Promise.all(
          offsets.map(async (offset, index) => {
            const limit = Math.min(pageSize, wanted - index * pageSize);
            const page = (await this.request(
              this.buildUrl(path, { ...baseQuery, limit, offset }),
            )) as Record<string, unknown>;
            pagesFetched++;
            onProgress?.(Math.min(wanted, (index + 1) * pageSize), wanted);
            return pick(page);
          }),
        );
        // Concatenate in offset order so results stay stable across runs.
        for (const batch of pages) items.push(...batch);
      }
    } else {
      const page = await this.request(this.buildUrl(path, baseQuery));
      pagesFetched = 1;
      items.push(...pick(page));
    }

    return { items: items.slice(0, cap), pagesFetched, truncated };
  }
}

function other(mode: "apikey" | "bearer"): "apikey" | "bearer" {
  return mode === "apikey" ? "bearer" : "apikey";
}

const DATE_BOUND_PARAMS: Record<string, "since" | "until"> = {
  since: "since",
  sinceAsDate: "since",
  start_date: "since",
  until: "until",
  untilAsDate: "until",
  end_date: "until",
};

/**
 * Coerce date-ish parameters into the format Keap accepts. The v1 API rejects
 * anything other than `YYYY-MM-DDTHH:mm:ss.SSSZ` with a 400, so a natural
 * "2026-01-01" from the caller has to be widened before it reaches the wire.
 */
export function normaliseQuery(
  endpoint: Endpoint,
  query: Record<string, unknown>,
): Record<string, unknown> {
  const declared = new Map(endpoint.params.map((p) => [p.name, p]));
  const out: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    const bound = DATE_BOUND_PARAMS[name];
    const isDateParam = bound || declared.get(name)?.format === "date-time";
    if (isDateParam && typeof value !== "boolean") {
      const normalised = normaliseDateBound(value, bound ?? "since");
      out[name] = normalised ?? value;
      continue;
    }
    out[name] = value;
  }
  return out;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function safeBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return undefined;
  }
}

function describeHttpError(status: number, body: unknown, config: Config): string {
  const detail =
    typeof body === "string"
      ? body
      : (body as { message?: string; fault?: { faultstring?: string } })?.message ||
        (body as { fault?: { faultstring?: string } })?.fault?.faultstring ||
        JSON.stringify(body ?? {}).slice(0, 300);

  if (status === 401 || status === 403) {
    return (
      `Keap rejected the request (${status}). Check KEAP_PAT in .env, and note the token is being sent ` +
      `as "${config.authMode === "bearer" ? "Authorization: Bearer" : "X-Keap-API-Key"}" — ` +
      `set KEAP_AUTH_MODE to switch. Detail: ${detail}`
    );
  }
  return `Keap returned ${status}. Detail: ${detail}`;
}

/** Substitute {path_params} from the supplied arguments. */
export function resolvePath(endpoint: Endpoint, query: Record<string, unknown>): string {
  return endpoint.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = query[name];
    if (value === undefined || value === null || value === "") {
      throw new KeapError(`Missing required path parameter "${name}" for ${endpoint.id}`);
    }
    return encodeURIComponent(String(value));
  });
}

/** Everything that is not a path placeholder becomes a query parameter. */
export function stripPathParams(
  endpoint: Endpoint,
  query: Record<string, unknown>,
): Record<string, unknown> {
  const pathNames = new Set(
    [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
  );
  return Object.fromEntries(
    Object.entries(query).filter(([key]) => !pathNames.has(key)),
  );
}
