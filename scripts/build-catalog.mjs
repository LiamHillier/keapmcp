#!/usr/bin/env node
/**
 * Builds src/catalog.json: every GET (read) operation from Keap's REST v1 and v2
 * OpenAPI contracts, normalised into a flat, searchable shape the server can use
 * to call any read endpoint without carrying the 1.3MB specs at runtime.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SPECS = [
  { version: "v1", file: "spec/keap-v1-openapi.json" },
  { version: "v2", file: "spec/keap-v2-openapi.json" },
];

/** Resolve a local $ref like "#/components/schemas/Foo" against the spec root. */
function deref(spec, node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 10) return node;
  if (node.$ref) {
    const path = node.$ref.replace(/^#\//, "").split("/");
    let cur = spec;
    for (const seg of path) cur = cur?.[seg];
    return deref(spec, cur, depth + 1);
  }
  return node;
}

function trim(text, max = 400) {
  if (!text) return undefined;
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

function schemaInfo(spec, schema) {
  const s = deref(spec, schema) || {};
  const info = { type: s.type || (s.enum ? "string" : "string") };
  if (s.enum) info.enum = s.enum.slice(0, 25);
  if (s.format) info.format = s.format;
  if (s.items) {
    const items = deref(spec, s.items);
    if (items?.type) info.items = items.type;
  }
  return info;
}

/**
 * Keap's v1 spec models query strings as a single object parameter (e.g.
 * `contactQueryCommand`). On the wire those properties are sent as ordinary
 * flat query params, so flatten them here.
 */
function flattenParams(spec, rawParams) {
  const out = [];
  for (const raw of rawParams || []) {
    const p = deref(spec, raw);
    if (!p?.name) continue;
    const schema = deref(spec, p.schema) || {};
    if (p.in === "query" && schema.type === "object" && schema.properties) {
      for (const [name, propSchema] of Object.entries(schema.properties)) {
        out.push({
          name,
          in: "query",
          required: false,
          description: trim(deref(spec, propSchema)?.description, 400),
          ...schemaInfo(spec, propSchema),
        });
      }
      continue;
    }
    out.push({
      name: p.name,
      in: p.in,
      required: Boolean(p.required),
      description: trim(p.description, 1500),
      ...schemaInfo(spec, p.schema),
    });
  }
  // De-duplicate by name+in, keeping the first (path params win over query).
  const seen = new Set();
  return out.filter((p) => {
    const key = `${p.in}:${p.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const PAGINATION_MARKERS = new Set([
  "next_page_token",
  "next",
  "previous",
  "count",
  "sync_token",
]);

/**
 * Decide whether an operation returns a *collection* (paginatable, aggregatable)
 * and if so which property holds it.
 *
 * Getting this wrong in either direction is costly: a single record classified
 * as a list makes `keap_get` return a nested array instead of the record (e.g.
 * /account/profile has a `business_goals` array but is one object), while a real
 * list classified as single loses pagination and aggregation. Hence the explicit
 * rules rather than "has an array property".
 */
function collectionKey(spec, operation) {
  const ok =
    operation.responses?.["200"] ||
    operation.responses?.["201"] ||
    operation.responses?.default;
  const schema = deref(spec, ok?.content?.["application/json"]?.schema);
  if (!schema) return undefined;

  // A bare array response is itself the collection.
  if (schema.type === "array") return "$root";
  if (!schema.properties) return undefined;

  const entries = Object.entries(schema.properties);
  const arrays = entries.filter(([, v]) => deref(spec, v)?.type === "array");
  if (arrays.length === 0) return undefined;

  const hasPagination = entries.some(([k]) => PAGINATION_MARKERS.has(k));
  if (hasPagination) {
    const pick = arrays.find(([k]) => !PAGINATION_MARKERS.has(k)) || arrays[0];
    return pick[0];
  }

  const scalars = entries.filter(([, v]) => deref(spec, v)?.type !== "array");
  // Exactly one array and nothing else: an unpaginated list such as
  // /rest/v2/shipping -> shipping_methods. Several arrays and nothing else is a
  // bundle (e.g. /model returns custom_fields + optional_properties), not a list.
  if (arrays.length === 1 && scalars.length === 0) return arrays[0][0];

  // One array alongside scalars is a single entity carrying a child collection,
  // unless the operation is explicitly a list.
  if (arrays.length === 1 && /^list/i.test(operation.operationId || "")) return arrays[0][0];

  return undefined;
}

function paginationStyle(params) {
  const names = new Set(params.map((p) => p.name));
  if (names.has("page_token") || names.has("page_size")) return "page_token";
  if (names.has("limit") || names.has("offset")) return "offset";
  return "none";
}

const catalog = [];

for (const { version, file } of SPECS) {
  const spec = JSON.parse(readFileSync(join(root, file), "utf8"));
  const server = spec.servers?.[0]?.url || "https://api.infusionsoft.com/crm";

  for (const [path, item] of Object.entries(spec.paths)) {
    const op = item.get;
    if (!op) continue;

    const params = flattenParams(spec, [
      ...(item.parameters || []),
      ...(op.parameters || []),
    ]);
    const key = collectionKey(spec, op);
    const operationId = op.operationId || path.replace(/\W+/g, "_");

    catalog.push({
      id: `${version}.${operationId}`,
      version,
      operationId,
      path,
      server,
      tag: op.tags?.[0] || "Other",
      summary: trim(op.summary, 200) || operationId,
      description: trim(op.description, 800),
      deprecated: Boolean(op.deprecated) || undefined,
      params,
      collectionKey: key,
      pagination: paginationStyle(params),
    });
  }
}

catalog.sort((a, b) => a.id.localeCompare(b.id));

// Fail loudly rather than shipping a silently-empty catalog.
if (catalog.length < 200) {
  throw new Error(`Catalog looks wrong: only ${catalog.length} read endpoints found`);
}

const out = {
  generatedFrom: "Keap REST v1 + v2 OpenAPI 3.1 contracts",
  endpointCount: catalog.length,
  endpoints: catalog,
};

writeFileSync(join(root, "src/catalog.json"), JSON.stringify(out, null, 1));

const byVersion = catalog.reduce((acc, e) => {
  acc[e.version] = (acc[e.version] || 0) + 1;
  return acc;
}, {});
const lists = catalog.filter((e) => e.collectionKey).length;
console.log(
  `catalog: ${catalog.length} read endpoints (${JSON.stringify(byVersion)}), ` +
    `${lists} return collections, ${new Set(catalog.map((e) => e.tag)).size} tags`,
);
