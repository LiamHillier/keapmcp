#!/usr/bin/env node
/**
 * End-to-end check: launches the built server over stdio as a real MCP client
 * and exercises every tool against the live Keap account.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const client = new Client({ name: "keapmcp-smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/index.js")], cwd: root }),
);

let failures = 0;

function body(result) {
  const raw = result.content?.[0]?.text ?? "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function check(label, name, args, inspect) {
  const started = Date.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    const value = body(result);
    if (result.isError) throw new Error(typeof value === "string" ? value : JSON.stringify(value));
    const detail = inspect ? inspect(value) : "ok";
    console.log(`PASS  ${label}  (${Date.now() - started}ms)  ${detail}`);
    return value;
  } catch (error) {
    failures++;
    console.log(`FAIL  ${label}  ${error.message}`);
    return undefined;
  }
}

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}\n`);

await check("whoami", "keap_whoami", {}, (v) => `${v.account?.name} · ${v.coverage?.read_endpoints} endpoints`);

await check(
  "find_endpoints",
  "keap_find_endpoints",
  { query: "subscription", lists_only: true },
  (v) => `${v.matched} matches`,
);

await check(
  "describe",
  "keap_describe_endpoint",
  { endpoint: "v1.listOrders" },
  (v) => `${v.parameters.length} params, returns ${v.returns}`,
);

await check(
  "describe+sample",
  "keap_describe_endpoint",
  { endpoint: "v2.listOpportunities", sample: true },
  (v) => `${v.sample_fields?.length ?? 0} field paths from live record`,
);

await check(
  "get (list + projection)",
  "keap_get",
  { endpoint: "v1.listOrders", max_items: 3, fields: ["id", "total", "status", "order_date"] },
  (v) => `${v.returned} orders, first total=${v.records?.[0]?.total}`,
);

await check(
  "get (single record)",
  "keap_get",
  { endpoint: "v1.getAccountProfile" },
  (v) => `account=${v.record?.name}`,
);

await check(
  "get (v2 pagination)",
  "keap_get",
  { endpoint: "v2.listContacts", max_items: 120, fields: ["id"] },
  (v) => `${v.returned} contacts over ${v.pages_fetched} pages`,
);

await check(
  "aggregate (revenue by year)",
  "keap_aggregate",
  {
    endpoint: "v1.listOrders",
    params: { since: "2025-01-01" },
    group_by: [{ field: "order_date", bucket: "year", as: "year" }],
    metrics: [
      { op: "count", as: "orders" },
      { op: "sum", field: "total", as: "revenue" },
    ],
    filter: [{ field: "status", op: "eq", value: "PAID" }],
    max_records: 3000,
  },
  (v) => `${v.records_after_filter} paid orders → ${JSON.stringify(v.groups)}`,
);

await check(
  "aggregate (v2 money conversion)",
  "keap_aggregate",
  {
    endpoint: "v2.listOrders",
    group_by: [{ field: "status", as: "status" }],
    metrics: [
      { op: "count", as: "orders" },
      { op: "sum", field: "total", as: "revenue" },
    ],
    max_records: 300,
  },
  (v) => `currencies=${JSON.stringify(v.currencies)} groups=${JSON.stringify(v.groups)}`,
);

await check(
  "aggregate (grand total, no group_by)",
  "keap_aggregate",
  { endpoint: "v1.listContacts", metrics: [{ op: "count", as: "contacts" }], max_records: 500 },
  (v) => `total row ${JSON.stringify(v.groups[0])}`,
);

await check(
  "report: revenue",
  "keap_report",
  { report: "revenue", since: "2026-01-01", period: "month", max_records: 3000 },
  (v) => `${JSON.stringify(v.headline)}`,
);

await check(
  "report: top_products",
  "keap_report",
  { report: "top_products", since: "2026-01-01", limit: 3, max_records: 3000 },
  (v) => `top=${v.rows?.[0]?.product} (${v.rows?.[0]?.revenue})`,
);

await check(
  "report: top_customers",
  "keap_report",
  { report: "top_customers", since: "2025-01-01", limit: 3, max_records: 3000 },
  (v) => `top spend=${v.rows?.[0]?.revenue}`,
);

await check(
  "report: contact_growth",
  "keap_report",
  { report: "contact_growth", since: "2026-01-01", period: "month", max_records: 5000 },
  (v) => `${JSON.stringify(v.headline.new_contacts)} new contacts across ${v.headline.periods} periods`,
);

await check("report: pipeline", "keap_report", { report: "pipeline", max_records: 2000 }, (v) =>
  `${v.headline.opportunities} opps across ${v.headline.stages} stages`,
);

await check("report: subscriptions", "keap_report", { report: "subscriptions", max_records: 2000 }, (v) =>
  `${v.headline.active_subscriptions} active, MRR ${v.headline.estimated_mrr}`,
);

await check("report: tasks", "keap_report", { report: "tasks", max_records: 1000 }, (v) =>
  `${v.headline.total_tasks} tasks, ${v.headline.overdue} overdue`,
);

// Error handling should be actionable rather than a stack trace.
const badEndpoint = await client.callTool({
  name: "keap_get",
  arguments: { endpoint: "v9.listUnicorns" },
});
console.log(
  badEndpoint.isError ? `PASS  unknown endpoint rejected` : `FAIL  unknown endpoint was accepted`,
);
if (!badEndpoint.isError) failures++;

const badParam = await client.callTool({
  name: "keap_get",
  arguments: { endpoint: "v1.listOrders", params: { nonsense_param: 1 } },
});
console.log(badParam.isError ? `PASS  unknown param rejected` : `FAIL  unknown param was accepted`);
if (!badParam.isError) failures++;

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
