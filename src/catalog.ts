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

export interface SearchOptions {
  query?: string;
  tag?: string;
  version?: "v1" | "v2";
  listsOnly?: boolean;
  limit?: number;
}

export function searchEndpoints(options: SearchOptions): Endpoint[] {
  const terms = (options.query || "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);

  const scored: Array<{ endpoint: Endpoint; score: number }> = [];

  for (const endpoint of endpoints) {
    if (options.version && endpoint.version !== options.version) continue;
    if (options.tag && endpoint.tag.toLowerCase() !== options.tag.toLowerCase()) continue;
    if (options.listsOnly && !endpoint.collectionKey) continue;

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
