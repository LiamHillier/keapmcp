import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./config.js";

export interface EndpointParam {
  name: string;
  in: "query" | "path" | "header" | string;
  required: boolean;
  type: string;
  format?: string;
  enum?: string[];
  items?: string;
  description?: string;
}

export interface Endpoint {
  id: string;
  version: "v1" | "v2";
  operationId: string;
  path: string;
  server: string;
  tag: string;
  summary: string;
  description?: string;
  deprecated?: boolean;
  params: EndpointParam[];
  /** Response property holding the result array, when the endpoint returns a list. */
  collectionKey?: string;
  pagination: "page_token" | "offset" | "none";
}

interface CatalogFile {
  endpointCount: number;
  endpoints: Endpoint[];
}

// The catalog is generated from Keap's OpenAPI contracts by scripts/build-catalog.mjs.
const data: CatalogFile = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "src/catalog.json"), "utf8"),
);

export const endpoints: Endpoint[] = data.endpoints;

const byId = new Map<string, Endpoint>();
for (const endpoint of endpoints) {
  byId.set(endpoint.id.toLowerCase(), endpoint);
  // Allow bare operationIds; v2 wins when the same name exists in both versions.
  const bare = endpoint.operationId.toLowerCase();
  if (!byId.has(bare) || endpoint.version === "v2") byId.set(bare, endpoint);
}

export const tags: string[] = [...new Set(endpoints.map((e) => e.tag))].sort();

export function getEndpoint(id: string): Endpoint | undefined {
  return byId.get(id.trim().toLowerCase());
}

/**
 * Resolve an endpoint from an id, operationId, or raw path such as
 * "/rest/v2/orders" or "v2/orders".
 */
export function resolveEndpoint(reference: string): Endpoint | undefined {
  const direct = getEndpoint(reference);
  if (direct) return direct;

  const normalised = reference.trim().replace(/^\/+/, "").replace(/\?.*$/, "");
  const withPrefix = normalised.startsWith("rest/") ? `/${normalised}` : `/rest/${normalised}`;
  return endpoints.find(
    (e) => e.path.toLowerCase() === withPrefix.toLowerCase() || e.path.toLowerCase() === `/${normalised.toLowerCase()}`,
  );
}

/**
 * A write (POST/PUT/PATCH/DELETE) operation. Only reachable through the
 * password-gated tools in writes.ts.
 */
export interface WriteEndpoint {
  id: string;
  version: "v1" | "v2";
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  operationId: string;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  deprecated?: boolean;
  params: EndpointParam[];
  /** Compact request body schema: type, properties, required, enum. */
  body?: Record<string, unknown>;
  bodyRequired?: boolean;
}

const writeData: { endpoints: WriteEndpoint[] } = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "src/write-catalog.json"), "utf8"),
);

export const writeEndpoints: WriteEndpoint[] = writeData.endpoints;

const writeById = new Map<string, WriteEndpoint>();
for (const endpoint of writeEndpoints) {
  writeById.set(endpoint.id.toLowerCase(), endpoint);
  const bare = endpoint.operationId.toLowerCase();
  if (!writeById.has(bare) || endpoint.version === "v2") writeById.set(bare, endpoint);
}

/** Resolve a write endpoint from its id ("v2.createTag") or bare operationId. */
export function resolveWriteEndpoint(reference: string): WriteEndpoint | undefined {
  return writeById.get(reference.trim().toLowerCase());
}

export function searchWriteEndpoints(options: SearchOptions & { method?: string }): WriteEndpoint[] {
  const method = options.method?.toUpperCase();
  return rank(
    writeEndpoints.filter((e) => !method || e.method === method),
    options,
    () => true,
  );
}

export function summariseWriteEndpoint(endpoint: WriteEndpoint): string {
  return `${endpoint.id}  ${endpoint.method} ${endpoint.path}  [${endpoint.tag}]  ${endpoint.summary}`;
}

export interface SearchOptions {
  query?: string;
  tag?: string;
  version?: "v1" | "v2";
  listsOnly?: boolean;
  limit?: number;
}

export function searchEndpoints(options: SearchOptions): Endpoint[] {
  return rank(endpoints, options, (e) => !options.listsOnly || Boolean(e.collectionKey));
}

interface Rankable {
  id: string;
  version: "v1" | "v2";
  operationId: string;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  collectionKey?: string;
}

function rank<T extends Rankable>(list: T[], options: SearchOptions, include: (e: T) => boolean): T[] {
  const terms = (options.query || "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);

  const scored: Array<{ endpoint: T; score: number }> = [];

  for (const endpoint of list) {
    if (options.version && endpoint.version !== options.version) continue;
    if (options.tag && endpoint.tag.toLowerCase() !== options.tag.toLowerCase()) continue;
    if (!include(endpoint)) continue;

    if (terms.length === 0) {
      scored.push({ endpoint, score: 0 });
      continue;
    }

    const haystack = [
      endpoint.operationId,
      endpoint.path,
      endpoint.tag,
      endpoint.summary,
      endpoint.description || "",
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      if (!haystack.includes(term)) {
        matchedAll = false;
        break;
      }
      if (endpoint.operationId.toLowerCase().includes(term)) score += 5;
      if (endpoint.path.toLowerCase().includes(term)) score += 4;
      if (endpoint.tag.toLowerCase().includes(term)) score += 3;
      score += 1;
    }
    if (!matchedAll) continue;
    // Prefer v2 (the current contract) and list endpoints when scores tie.
    if (endpoint.version === "v2") score += 1;
    if (endpoint.collectionKey) score += 1;
    scored.push({ endpoint, score });
  }

  scored.sort((a, b) => b.score - a.score || a.endpoint.id.localeCompare(b.endpoint.id));
  return scored.slice(0, options.limit ?? 40).map((s) => s.endpoint);
}

export function summariseEndpoint(endpoint: Endpoint): string {
  const kind = endpoint.collectionKey ? `list → ${endpoint.collectionKey}[]` : "single";
  return `${endpoint.id}  ${endpoint.path}  [${endpoint.tag}, ${kind}]  ${endpoint.summary}`;
}
