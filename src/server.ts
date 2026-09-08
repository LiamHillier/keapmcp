import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "./config.js";
import {
  KeapClient,
  KeapError,
  normaliseQuery,
  resolvePath,
  stripPathParams,
  type ProgressFn,
} from "./client.js";
import {
  endpoints,
  resolveEndpoint,
  searchEndpoints,
  summariseEndpoint,
  tags,
  type Endpoint,
} from "./catalog.js";
import {
  aggregate,
  applyFilters,
  project,
  type Bucket,
  type Filter,
  type Metric,
} from "./analyze.js";
import { REPORTS, runReport, type ReportName } from "./reports.js";

const BUCKETS = ["none", "hour", "day", "week", "month", "quarter", "year", "dow"] as const;
const OPERATORS = [
  "eq", "ne", "gt", "gte", "lt", "lte",
  "contains", "not_contains", "starts_with",
  "in", "not_in", "exists", "not_exists",
] as const;

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function failure(error: unknown) {
  const message =
    error instanceof KeapError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { ...text(`Error: ${message}`), isError: true as const };
}

/**
 * Bridge page-fetch progress to MCP progress notifications. Large reports can
 * take tens of seconds, and clients typically reset their request timeout when
 * progress arrives — without this a long-running report is killed mid-flight.
 */
function progressReporter(extra: {
  sendNotification?: (notification: unknown) => Promise<void>;
  _meta?: { progressToken?: string | number };
}): ProgressFn | undefined {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra.sendNotification) return undefined;

  let lastSent = 0;
  return (fetched, total) => {
    const now = Date.now();
    if (now - lastSent < 400) return;
    lastSent = now;
    void extra
      .sendNotification!({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: fetched,
          total,
          message: total ? `Fetched ${fetched} of ${total} records` : `Fetched ${fetched} records`,
        },
      })
      .catch(() => undefined);
  };
}

/** Reject unknown parameter names early with a list of what the endpoint accepts. */
function validateParams(endpoint: Endpoint, params: Record<string, unknown>): string | undefined {
  const known = new Set(endpoint.params.map((p) => p.name));
  for (const name of ["page_size", "page_token", "limit", "offset", "fields", "filter", "order_by"]) {
    known.add(name);
  }
  const unknown = Object.keys(params).filter((name) => !known.has(name));
  if (!unknown.length) return undefined;
  return (
    `Unknown parameter(s) for ${endpoint.id}: ${unknown.join(", ")}. ` +
    `Accepted: ${endpoint.params.map((p) => p.name).join(", ") || "(none)"}. ` +
    `Call keap_describe_endpoint for full details.`
  );
}

/**
 * Build a fully wired MCP server over a shared Keap client.
 *
 * A server instance can only be attached to one transport, so each transport
 * (the stdio process, or every HTTP request in stateless mode) needs its own.
 * The Keap client is deliberately shared: its cache and rate limiter must span
 * all sessions so the account-wide 10 QPS token throttle is respected.
 */
export function createServer(client: KeapClient, config: Config): McpServer {
  const server = new McpServer(
    { name: "keapmcp", version: "1.0.0" },
    {
      instructions:
        "Read-only access to a Keap (Infusionsoft) CRM account, covering every GET endpoint of the " +
        "REST v1 and v2 APIs, plus tools for aggregating and reporting on that data.\n\n" +
        "How to answer analytical questions:\n" +
        "1. keap_report handles the common ones directly (revenue, top products, top customers, " +
        "contact growth, pipeline, subscriptions, tasks). Try it first.\n" +
        "2. For anything else, keap_find_endpoints locates the right endpoint, keap_describe_endpoint " +
        "shows its parameters and result fields, then keap_aggregate groups and totals the records.\n" +
        "3. keap_get returns raw records when you need to inspect individual entities.\n\n" +
        "Never page through raw records to compute a total — keap_aggregate does that server-side and " +
        "returns only the summary. Money in v2 responses is cents-encoded and is converted to major " +
        "units automatically.",
    },
  );

  server.registerTool(
    "keap_whoami",
    {
      title: "Keap connection and account info",
      description:
        "Verify the Keap connection and show the account profile, plus what this server can reach. " +
        "Run this first if anything else returns an auth error.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!config.token) {
          return failure(
            "No Keap token configured. Set KEAP_PAT in the project's .env file to a Personal Access Token " +
              "or Service Account Key (Keap: Settings → API Settings).",
          );
        }
        const probe = await client.probeAuth();
        if (!probe.ok) return failure(probe.detail || "Authentication failed");

        const profile = (await client.request(
          client.buildUrl("/rest/v1/account/profile"),
        )) as Record<string, unknown>;

        return text({
          connected: true,
          auth: {
            header: probe.workingMode === "bearer" ? "Authorization: Bearer" : "X-Keap-API-Key",
            configured_mode: config.authMode,
          },
          account: {
            name: profile.name,
            email: profile.email,
            phone: profile.phone,
            website: profile.website,
            address: profile.address,
            currency_code: profile.currency_code,
            time_zone: profile.time_zone,
          },
          coverage: {
            read_endpoints: endpoints.length,
            v1: endpoints.filter((e) => e.version === "v1").length,
            v2: endpoints.filter((e) => e.version === "v2").length,
            list_endpoints: endpoints.filter((e) => e.collectionKey).length,
            tags: tags.length,
          },
          limits: {
            max_qps: config.maxQps,
            note: "Keap throttles tokens at 10 QPS / 240 per minute / 30,000 per day.",
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "keap_find_endpoints",
    {
      title: "Search Keap read endpoints",
      description:
        "Search all " +
        endpoints.length +
        " read endpoints of the Keap REST API by keyword, tag or version. Use this to discover which " +
        "endpoint holds the data a question needs (e.g. 'subscription', 'affiliate commission', 'lead source'). " +
        "Returns endpoint ids to pass to keap_describe_endpoint, keap_get or keap_aggregate.",
      inputSchema: {
        query: z.string().optional().describe("Keywords, e.g. 'orders', 'affiliate payments', 'custom fields'"),
        tag: z.string().optional().describe(`Restrict to one API area. Available: ${tags.join(", ")}`),
        version: z.enum(["v1", "v2"]).optional().describe("Restrict to the v1 or v2 API"),
        lists_only: z.boolean().optional().describe("Only endpoints that return a collection (aggregatable)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max results, default 40"),
      },
    },
    async ({ query, tag, version, lists_only, limit }) => {
      try {
        const matches = searchEndpoints({ query, tag, version, listsOnly: lists_only, limit });
        if (!matches.length) {
          return text(
            `No read endpoints matched. Available tags: ${tags.join(", ")}. ` +
              `Try a broader keyword or drop the tag/version filter.`,
          );
        }
        return text({
          matched: matches.length,
          of_total: endpoints.length,
          endpoints: matches.map(summariseEndpoint),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "keap_describe_endpoint",
    {
      title: "Describe a Keap endpoint",
      description:
        "Show the full parameter list, pagination style and result shape for one read endpoint. " +
        "Use before keap_get or keap_aggregate when unsure which filters or field names are available.",
      inputSchema: {
        endpoint: z
          .string()
          .describe("Endpoint id, operationId or path — e.g. 'v2.listOrders', 'listOrders', '/rest/v2/orders'"),
        sample: z
          .boolean()
          .optional()
          .describe("Also fetch one live record so the actual field names are visible. Default false."),
      },
    },
    async ({ endpoint: reference, sample }) => {
      try {
        const endpoint = resolveEndpoint(reference);
        if (!endpoint) {
          const guesses = searchEndpoints({ query: reference, limit: 8 }).map((e) => e.id);
          return failure(
            `Unknown endpoint "${reference}".` +
              (guesses.length ? ` Did you mean: ${guesses.join(", ")}?` : " Use keap_find_endpoints to search."),
          );
        }

        const described: Record<string, unknown> = {
          id: endpoint.id,
          path: endpoint.path,
          version: endpoint.version,
          area: endpoint.tag,
          summary: endpoint.summary,
          description: endpoint.description,
          deprecated: endpoint.deprecated,
          returns: endpoint.collectionKey
            ? `collection in "${endpoint.collectionKey}" — aggregatable with keap_aggregate`
            : "a single object",
          pagination: endpoint.pagination,
          parameters: endpoint.params.map((p) => ({
            name: p.name,
            in: p.in,
            type: p.enum ? `enum(${p.enum.join("|")})` : p.format ? `${p.type}/${p.format}` : p.type,
            required: p.required || undefined,
            description: p.description,
          })),
        };

        if (sample) {
          try {
            const pathParams = [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
            if (pathParams.length) {
              described.sample = `Not fetched: this endpoint needs path parameter(s) ${pathParams.join(", ")}.`;
            } else if (endpoint.collectionKey) {
              const { items } = await client.fetchAll(endpoint, {}, 1);
              described.sample_record = items[0] ?? null;
              described.sample_fields = items[0] ? fieldPaths(items[0]) : [];
            } else {
              const raw = await client.request(client.buildUrl(endpoint.path));
              described.sample_record = raw;
              described.sample_fields = fieldPaths(raw);
            }
          } catch (error) {
            described.sample = `Could not fetch a sample: ${(error as Error).message}`;
          }
        }

        return text(described);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "keap_get",
    {
      title: "Call any Keap read endpoint",
      description:
        "Fetch raw records from any of the Keap read endpoints, following pagination automatically. " +
        "Use for looking at individual records or small lists. For totals, counts or breakdowns use " +
        "keap_aggregate instead — it avoids pulling thousands of records through the conversation.",
      inputSchema: {
        endpoint: z.string().describe("Endpoint id, operationId or path, e.g. 'v2.listOrders' or 'v1.getContact'"),
        params: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Path and query parameters, e.g. {contact_id: 123} or {since: '2026-01-01'}. " +
              "See keap_describe_endpoint for what each endpoint accepts. On v2 endpoints the `filter` " +
              "parameter takes exactly ONE condition in `field==value` form (e.g. \"paid==true\"); " +
              "Keap rejects comma-joined or repeated conditions, so apply any further narrowing " +
              "with the `filter` argument of this tool instead.",
          ),
        max_items: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe("Max records to return from a list endpoint. Default 50."),
        fields: z
          .array(z.string())
          .optional()
          .describe("Keep only these dotted field paths, e.g. ['id','total','contact.email']. Cuts response size."),
        filter: z
          .array(
            z.object({
              field: z.string(),
              op: z.enum(OPERATORS),
              value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
            }),
          )
          .optional()
          .describe("Client-side filters applied after fetching, for fields the API cannot filter on."),
      },
    },
    async ({ endpoint: reference, params = {}, max_items, fields, filter }, extra) => {
      try {
        const endpoint = resolveEndpoint(reference);
        if (!endpoint) {
          const guesses = searchEndpoints({ query: reference, limit: 8 }).map((e) => e.id);
          return failure(
            `Unknown endpoint "${reference}".` +
              (guesses.length ? ` Did you mean: ${guesses.join(", ")}?` : " Use keap_find_endpoints to search."),
          );
        }

        const problem = validateParams(endpoint, params);
        if (problem) return failure(problem);

        const maxItems = max_items ?? 50;

        if (!endpoint.collectionKey) {
          const normalised = normaliseQuery(endpoint, params);
          const url = client.buildUrl(
            resolvePath(endpoint, normalised),
            stripPathParams(endpoint, normalised),
          );
          const raw = await client.request(url);
          const shaped = fields?.length ? project([raw], fields)[0] : raw;
          return text({ endpoint: endpoint.id, record: shaped });
        }

        const { items, pagesFetched, truncated } = await client.fetchAll(
          endpoint,
          params,
          maxItems,
          progressReporter(extra as never),
        );
        const filtered = filter?.length ? applyFilters(items, filter as Filter[]) : items;
        const shaped = fields?.length ? project(filtered, fields) : filtered;

        return text({
          endpoint: endpoint.id,
          returned: shaped.length,
          fetched: items.length,
          pages_fetched: pagesFetched,
          truncated_at_max_items: truncated || undefined,
          note: truncated
            ? "More records exist. Raise max_items, narrow with params, or use keap_aggregate for totals."
            : undefined,
          records: shaped,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "keap_aggregate",
    {
      title: "Group and summarise Keap records",
      description:
        "Answer analytical questions over any Keap list endpoint: group records by a field or time period " +
        "and compute counts, sums, averages, min/max and distinct counts. Pages through all matching " +
        "records internally and returns only the summary.\n\n" +
        "Examples: revenue by month from v1.listOrders (group_by order_date/month, sum of total); " +
        "opportunities by stage from v2.listOpportunities (group_by stage.name); " +
        "contacts by owner from v1.listContacts (group_by owner_id).\n\n" +
        "Money fields in v2 responses are cents-encoded objects and are converted to major units automatically.",
      inputSchema: {
        endpoint: z
          .string()
          .describe("A list endpoint id, e.g. 'v1.listOrders'. Use keap_find_endpoints with lists_only=true."),
        params: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Server-side query parameters, e.g. {since: '2026-01-01', until: '2026-06-30'} on v1, or " +
              "{filter: 'created_since_time==2026-01-01T00:00:00.000Z'} on v2. v2 accepts only ONE " +
              "filter condition; do further narrowing with the `filter` argument below.",
          ),
        group_by: z
          .array(
            z.object({
              field: z.string().describe("Dotted field path, e.g. 'status' or 'contact.id' or 'order_date'"),
              bucket: z
                .enum(BUCKETS)
                .optional()
                .describe("Bucket a date field into periods. 'dow' groups by day of week."),
              as: z.string().optional().describe("Label for this grouping column"),
            }),
          )
          .optional()
          .describe("Fields to group by. Omit for a single grand-total row."),
        metrics: z
          .array(
            z.object({
              op: z.enum(["count", "sum", "avg", "min", "max", "distinct"]),
              field: z.string().optional().describe("Required for every op except count"),
              as: z.string().optional(),
            }),
          )
          .optional()
          .describe("Metrics to compute. Defaults to a record count."),
        filter: z
          .array(
            z.object({
              field: z.string(),
              op: z.enum(OPERATORS),
              value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
            }),
          )
          .optional()
          .describe("Filters applied to records before grouping, e.g. [{field:'status',op:'eq',value:'PAID'}]"),
        sort_by: z.string().optional().describe("Result column to sort by. Defaults to the first metric, or the period."),
        sort_dir: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Max groups returned. Default 50."),
        max_records: z
          .number()
          .int()
          .min(1)
          .max(50000)
          .optional()
          .describe("Cap on records pulled from the API. Default 10000."),
        include_samples: z.boolean().optional().describe("Include up to 3 raw records so field names can be checked"),
      },
    },
    async (args, extra) => {
      try {
        const endpoint = resolveEndpoint(args.endpoint);
        if (!endpoint) {
          const guesses = searchEndpoints({ query: args.endpoint, listsOnly: true, limit: 8 }).map((e) => e.id);
          return failure(
            `Unknown endpoint "${args.endpoint}".` +
              (guesses.length ? ` Did you mean: ${guesses.join(", ")}?` : ""),
          );
        }
        if (!endpoint.collectionKey) {
          return failure(
            `${endpoint.id} returns a single object, not a collection, so there is nothing to aggregate. ` +
              `Use keap_get for this endpoint.`,
          );
        }

        const params = args.params ?? {};
        const problem = validateParams(endpoint, params);
        if (problem) return failure(problem);

        const { items, pagesFetched, truncated } = await client.fetchAll(
          endpoint,
          params,
          args.max_records ?? 10_000,
          progressReporter(extra as never),
        );
        const filtered = args.filter?.length ? applyFilters(items, args.filter as Filter[]) : items;

        const result = aggregate(
          filtered,
          (args.group_by ?? []).map((g) => ({ field: g.field, bucket: g.bucket as Bucket | undefined, as: g.as })),
          (args.metrics ?? []) as Metric[],
          { sortBy: args.sort_by, sortDir: args.sort_dir, limit: args.limit ?? 50 },
        );

        return text({
          endpoint: endpoint.id,
          records_fetched: items.length,
          records_after_filter: filtered.length,
          pages_fetched: pagesFetched,
          truncated_at_max_records: truncated || undefined,
          warning: truncated
            ? "Hit max_records — figures are based on a partial dataset. Narrow the window or raise max_records."
            : undefined,
          currencies: result.currencies,
          totals: result.totals,
          group_count: result.groupCount,
          groups_returned: result.groups.length,
          groups: result.groups,
          samples: args.include_samples ? filtered.slice(0, 3) : undefined,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "keap_report",
    {
      title: "Prebuilt Keap analytics reports",
      description:
        "Ready-made analytics that already know the right endpoints and field names:\n" +
        Object.entries(REPORTS)
          .map(([name, description]) => `• ${name} — ${description}`)
          .join("\n") +
        "\n\nStart here for business questions about sales, customers, growth, pipeline or recurring revenue.",
      inputSchema: {
        report: z.enum(Object.keys(REPORTS) as [ReportName, ...ReportName[]]).describe("Which report to run"),
        since: z.string().optional().describe("Start of the window, ISO date e.g. '2026-01-01'"),
        until: z.string().optional().describe("End of the window, ISO date e.g. '2026-12-31'"),
        period: z
          .enum(BUCKETS)
          .optional()
          .describe("Time bucket for time-series reports (revenue, contact_growth). Default 'month'."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows for ranked reports. Default 25."),
        max_records: z
          .number()
          .int()
          .min(1)
          .max(50000)
          .optional()
          .describe("Cap on records pulled from the API. Default 10000."),
        include_unpaid: z
          .boolean()
          .optional()
          .describe("Include orders that are not PAID in revenue reports. Default false."),
      },
    },
    async (args, extra) => {
      try {
        const output = await runReport(client, {
          report: args.report,
          since: args.since,
          until: args.until,
          period: args.period as Bucket | undefined,
          limit: args.limit,
          maxRecords: args.max_records,
          includeUnpaid: args.include_unpaid,
          onProgress: progressReporter(extra as never),
        });
        return text(output);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

/** Collect dotted paths present in a sample record, so field names are discoverable. */
function fieldPaths(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 3 || value === null || typeof value !== "object") return prefix ? [prefix] : [];
  if (Array.isArray(value)) {
    return value.length ? fieldPaths(value[0], prefix, depth + 1) : [prefix];
  }
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object") out.push(...fieldPaths(child, path, depth + 1));
    else out.push(path);
  }
  return out.slice(0, 120);
}
