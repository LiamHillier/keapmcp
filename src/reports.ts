/**
 * Canned analytical reports over Keap data.
 *
 * These exist because answering "how much did we make last quarter" through the
 * raw API means knowing that v1 orders carry `order_date` and numeric `total`
 * while v2 orders carry `order_time` and cents-encoded money objects. Each
 * report pins the right endpoint and field names so the question can be asked
 * in plain language.
 */
import type { KeapClient, ProgressFn } from "./client.js";
import { getEndpoint, type Endpoint } from "./catalog.js";
import {
  aggregate,
  applyFilters,
  bucketDate,
  getPath,
  normaliseDateBound,
  parseDate,
  toNumber,
  type Bucket,
  type Filter,
} from "./analyze.js";

export type ReportName =
  | "revenue"
  | "top_products"
  | "top_customers"
  | "contact_growth"
  | "pipeline"
  | "subscriptions"
  | "tasks";

export const REPORTS: Record<ReportName, string> = {
  revenue: "Order revenue over time — order count, revenue, average order value. Source: v1 orders.",
  top_products: "Best-selling products by revenue and units, from order line items (tax and fees excluded). Source: v2 orders.",
  top_customers: "Highest-spending contacts by total order revenue. Source: v1 orders.",
  contact_growth: "New contacts created per period. Source: v1 contacts.",
  pipeline: "Opportunities grouped by stage, with counts, projected revenue and a probability-weighted value. Source: v1 opportunities.",
  subscriptions: "Active subscriptions and estimated recurring revenue normalised to monthly. Source: v2 subscriptions.",
  tasks: "Tasks by status/owner, and how many are overdue. Source: v1 tasks.",
};

export interface ReportOptions {
  report: ReportName;
  since?: string;
  until?: string;
  period?: Bucket;
  limit?: number;
  maxRecords?: number;
  includeUnpaid?: boolean;
  onProgress?: ProgressFn;
}

export interface ReportOutput {
  report: ReportName;
  source: { endpoint: string; recordsFetched: number; truncated: boolean };
  window?: { since?: string; until?: string };
  headline: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  notes?: string[];
}

function requireEndpoint(id: string): Endpoint {
  const endpoint = getEndpoint(id);
  if (!endpoint) throw new Error(`Report is misconfigured: endpoint "${id}" is not in the catalog`);
  return endpoint;
}

/**
 * Clip records to a date window locally, since not every endpoint filters
 * server-side and the ones that do filter on a different field than we group by.
 * Bounds go through the same normalisation as query params so that a bare
 * `until` date covers the whole of that day.
 */
function windowFilter(since?: string, until?: string, field = "order_date"): Filter[] {
  const filters: Filter[] = [];
  const from = normaliseDateBound(since, "since");
  const to = normaliseDateBound(until, "until");
  if (from) filters.push({ field, op: "gte", value: from });
  if (to) filters.push({ field, op: "lte", value: to });
  return filters;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Line-item `name` values that are really the line type, not a product name. */
const GENERIC_ITEM_NAMES = new Set([
  "product",
  "subscription",
  "special",
  "special category",
  "shipping",
  "tax",
  "",
]);

/**
 * Orders created by storefront integrations name every line after its type and
 * put the real product in `description` (often with a SKU suffix and HTML
 * entities). Grouping on `name` alone collapses the whole catalogue into one
 * row called "Product", so fall back to the description when the name is generic.
 */
function productLabel(item: unknown): string {
  const name = String(getPath(item, "name") ?? "").trim();
  if (!GENERIC_ITEM_NAMES.has(name.toLowerCase())) return name;

  const description = String(getPath(item, "description") ?? "").trim();
  if (!description) return name || "(unnamed)";

  return (
    description
      .replace(/\s*SKU:\s*\S+\s*$/i, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim() || name || "(unnamed)"
  );
}

export async function runReport(client: KeapClient, options: ReportOptions): Promise<ReportOutput> {
  const period = options.period ?? "month";
  const limit = options.limit ?? 25;
  const maxRecords = options.maxRecords ?? 10_000;
  const notes: string[] = [];

  switch (options.report) {
    case "revenue": {
      const endpoint = requireEndpoint("v1.listOrders");
      const { items, truncated } = await client.fetchAll(
        endpoint,
        { since: options.since, until: options.until },
        maxRecords,
        options.onProgress,
      );
      let orders = applyFilters(items, windowFilter(options.since, options.until));
      if (!options.includeUnpaid) {
        orders = applyFilters(orders, [{ field: "status", op: "eq", value: "PAID" }]);
        notes.push('Only orders with status "PAID" are counted. Pass include_unpaid=true to count all orders.');
      }

      const result = aggregate(
        orders,
        [{ field: "order_date", bucket: period, as: "period" }],
        [
          { op: "count", as: "orders" },
          { op: "sum", field: "total", as: "revenue" },
          { op: "avg", field: "total", as: "avg_order_value" },
        ],
        { sortBy: "period", sortDir: "asc" },
      );

      const revenue = result.totals.revenue ?? 0;
      return {
        report: "revenue",
        source: { endpoint: endpoint.id, recordsFetched: items.length, truncated },
        window: { since: options.since, until: options.until },
        headline: {
          total_revenue: round(revenue),
          orders: orders.length,
          avg_order_value: orders.length ? round(revenue / orders.length) : 0,
          periods: result.groupCount,
        },
        rows: result.groups,
        notes,
      };
    }

    case "top_products": {
      // v2 rather than v1: in v1 every line item is named after its type
      // ("Product", "Tax", "Special Category") with the real product name buried
      // in `description`. v2 line items carry the actual product name and an
      // `item_type` that separates products from tax and fees.
      const endpoint = requireEndpoint("v2.listOrders");
      const since = normaliseDateBound(options.since, "since");
      const { items, truncated } = await client.fetchAll(
        endpoint,
        since ? { filter: `created_since_time==${since}` } : {},
        maxRecords,
        options.onProgress,
      );
      let orders = applyFilters(items, windowFilter(options.since, options.until, "creation_time"));
      if (!options.includeUnpaid) {
        orders = applyFilters(orders, [{ field: "status", op: "eq", value: "PAID" }]);
        notes.push('Only orders with status "PAID" are counted.');
      }
      notes.push("The date window applies to order creation time.");

      // Line-item revenue is price x quantity, which needs a real fold rather
      // than a plain sum over a single field.
      const byProduct = new Map<string, { product: string; units: number; revenue: number; orders: Set<string> }>();
      for (const order of orders) {
        const orderId = String(getPath(order, "id") ?? "");
        for (const item of (getPath(order, "order_items") as unknown[]) ?? []) {
          // Skip tax, shipping and fee lines so "top products" means products.
          const itemType = String(getPath(item, "item_type") ?? "PRODUCT").toUpperCase();
          if (itemType !== "PRODUCT" && itemType !== "SUBSCRIPTION") continue;
          const name = productLabel(item);
          const price = toNumber(getPath(item, "price_per_unit")) ?? 0;
          const quantity = toNumber(getPath(item, "quantity")) ?? 0;
          const entry = byProduct.get(name) ?? { product: name, units: 0, revenue: 0, orders: new Set<string>() };
          entry.units += quantity;
          entry.revenue += price * quantity;
          entry.orders.add(orderId);
          byProduct.set(name, entry);
        }
      }

      const rows = [...byProduct.values()]
        .map((entry) => ({
          product: entry.product,
          revenue: round(entry.revenue),
          units: round(entry.units),
          orders: entry.orders.size,
        }))
        .sort((a, b) => b.revenue - a.revenue);

      return {
        report: "top_products",
        source: { endpoint: endpoint.id, recordsFetched: items.length, truncated },
        window: { since: options.since, until: options.until },
        headline: {
          distinct_products: rows.length,
          line_item_revenue: round(rows.reduce((sum, r) => sum + r.revenue, 0)),
          orders_considered: orders.length,
        },
        rows: rows.slice(0, limit),
        notes,
      };
    }

    case "top_customers": {
      const endpoint = requireEndpoint("v1.listOrders");
      const { items, truncated } = await client.fetchAll(
        endpoint,
        { since: options.since, until: options.until },
        maxRecords,
        options.onProgress,
      );
      let orders = applyFilters(items, windowFilter(options.since, options.until));
      if (!options.includeUnpaid) {
        orders = applyFilters(orders, [{ field: "status", op: "eq", value: "PAID" }]);
        notes.push('Only orders with status "PAID" are counted.');
      }

      const result = aggregate(
        orders,
        [{ field: "contact.id", as: "contact_id" }],
        [
          { op: "count", as: "orders" },
          { op: "sum", field: "total", as: "revenue" },
          { op: "max", field: "order_date", as: "last_order" },
        ],
        { sortBy: "revenue", sortDir: "desc", limit },
      );

      // Attach a human-readable identity to each contact id.
      const identity = new Map<string, string>();
      for (const order of orders) {
        const id = String(getPath(order, "contact.id") ?? "");
        if (id && !identity.has(id)) {
          const name = [getPath(order, "contact.first_name"), getPath(order, "contact.last_name")]
            .filter(Boolean)
            .join(" ");
          identity.set(id, name || String(getPath(order, "contact.email") ?? ""));
        }
      }
      const rows = result.groups.map((row) => {
        const id = String(row.contact_id);
        const orderForContact = orders.find((o) => String(getPath(o, "contact.id")) === id);
        return {
          contact_id: id,
          name: identity.get(id) || "(unknown)",
          email: getPath(orderForContact, "contact.email") ?? null,
          revenue: row.revenue,
          orders: row.orders,
        };
      });

      return {
        report: "top_customers",
        source: { endpoint: endpoint.id, recordsFetched: items.length, truncated },
        window: { since: options.since, until: options.until },
        headline: {
          distinct_customers: result.groupCount,
          total_revenue: round(result.totals.revenue ?? 0),
          orders_considered: orders.length,
        },
        rows,
        notes,
      };
    }

    case "contact_growth": {
      const endpoint = requireEndpoint("v1.listContacts");
      const { items, truncated } = await client.fetchAll(
        endpoint,
        { since: options.since, until: options.until },
        maxRecords,
        options.onProgress,
      );
      const contacts = applyFilters(items, windowFilter(options.since, options.until, "date_created"));
      const result = aggregate(
        contacts,
        [{ field: "date_created", bucket: period, as: "period" }],
        [{ op: "count", as: "new_contacts" }],
        { sortBy: "period", sortDir: "asc" },
      );
      const counts = result.groups.map((row) => Number(row.new_contacts) || 0);
      return {
        report: "contact_growth",
        source: { endpoint: endpoint.id, recordsFetched: items.length, truncated },
        window: { since: options.since, until: options.until },
        headline: {
          new_contacts: contacts.length,
          periods: result.groupCount,
          avg_per_period: counts.length ? round(counts.reduce((a, b) => a + b, 0) / counts.length) : 0,
          best_period: result.groups.length
            ? [...result.groups].sort((a, b) => Number(b.new_contacts) - Number(a.new_contacts))[0]
            : null,
        },
        rows: result.groups,
        notes,
      };
    }

    case "pipeline": {
      // v1 rather than v2: the fields are identical, but v1 pages by
      // limit/offset so all pages can be fetched in parallel. v2 pages by
      // opaque token, which is strictly sequential — on an account with tens of
      // thousands of opportunities that is the difference between 10s and 2min.
      const endpoint = requireEndpoint("v1.listOpportunities");
      const { items, truncated } = await client.fetchAll(endpoint, {}, maxRecords, options.onProgress);
      const opportunities = applyFilters(items, windowFilter(options.since, options.until, "date_created"));

      const result = aggregate(
        opportunities,
        [{ field: "stage.name", as: "stage" }],
        [
          { op: "count", as: "opportunities" },
          { op: "sum", field: "projected_revenue_low", as: "projected_low" },
          { op: "sum", field: "projected_revenue_high", as: "projected_high" },
          { op: "avg", field: "stage.details.probability", as: "probability" },
        ],
        { sortBy: "opportunities", sortDir: "desc" },
      );

      // Order stages by the pipeline order Keap defines, not by volume.
      const stageOrder = new Map<string, number>();
      for (const opportunity of opportunities) {
        const name = String(getPath(opportunity, "stage.name") ?? "");
        const order = toNumber(getPath(opportunity, "stage.details.stage_order"));
        if (name && order !== undefined && !stageOrder.has(name)) stageOrder.set(name, order);
      }
      const rows = [...result.groups].sort(
        (a, b) => (stageOrder.get(String(a.stage)) ?? 999) - (stageOrder.get(String(b.stage)) ?? 999),
      );

      const weighted = opportunities.reduce<number>((sum, opportunity) => {
        const high = toNumber(getPath(opportunity, "projected_revenue_high")) ?? 0;
        const probability = toNumber(getPath(opportunity, "stage.details.probability")) ?? 0;
        return sum + (high * probability) / 100;
      }, 0);

      notes.push(
        "Projected revenue comes from the opportunity's own low/high estimates; these are 0 when nobody filled them in.",
      );
      notes.push(
        "All stages are included, closed ones too. Won and Lost are terminal — exclude them for open-pipeline figures.",
      );
      return {
        report: "pipeline",
        source: { endpoint: endpoint.id, recordsFetched: items.length, truncated },
        window: { since: options.since, until: options.until },
        headline: {
          opportunities: opportunities.length,
          stages: result.groupCount,
          projected_high_total: round(result.totals.projected_high ?? 0),
          probability_weighted_value: round(weighted),
        },
        rows,
        notes,
      };
    }

    case "subscriptions": {
      const endpoint = requireEndpoint("v2.listSubscriptions");
      const { items, truncated } = await client.fetchAll(endpoint, {}, maxRecords, options.onProgress);

      // Normalise every billing cadence to a comparable monthly figure.
      const perMonth = (record: unknown): number => {
        const amount = toNumber(getPath(record, "billing_amount")) ?? 0;
        const frequency = Math.max(1, toNumber(getPath(record, "billing_frequency")) ?? 1);
        switch (String(getPath(record, "billing_cycle") ?? "").toUpperCase()) {
          case "DAY": return (amount * 30.4375) / frequency;
          case "WEEK": return (amount * 4.348) / frequency;
          case "MONTH": return amount / frequency;
          case "YEAR": return amount / (12 * frequency);
          default: return 0;
        }
      };

      const active = items.filter((record) => getPath(record, "active") === true);
      const mrr = active.reduce<number>((sum, record) => sum + perMonth(record), 0);

      const byCycle = new Map<string, { cycle: string; active: number; total: number; monthly: number }>();
      for (const record of items) {
        const cycle = String(getPath(record, "billing_cycle") ?? "(none)").toUpperCase();
        const entry = byCycle.get(cycle) ?? { cycle, active: 0, total: 0, monthly: 0 };
        entry.total++;
        if (getPath(record, "active") === true) {
          entry.active++;
          entry.monthly += perMonth(record);
        }
        byCycle.set(cycle, entry);
      }

      notes.push(
        "MRR normalises each active subscription's billing_amount to a monthly figure (day x30.44, week x4.35, year ÷12).",
      );
      return {
        report: "subscriptions",
        source: { endpoint: endpoint.id, recordsFetched: items.length, truncated },
        headline: {
          active_subscriptions: active.length,
          total_subscriptions: items.length,
          estimated_mrr: round(mrr),
          estimated_arr: round(mrr * 12),
        },
        rows: [...byCycle.values()]
          .map((entry) => ({ ...entry, monthly: round(entry.monthly) }))
          .sort((a, b) => b.monthly - a.monthly),
        notes,
      };
    }

    case "tasks": {
      const endpoint = requireEndpoint("v1.listTasks");
      const { items, truncated } = await client.fetchAll(endpoint, {}, maxRecords, options.onProgress);
      const now = Date.now();
      const overdue = items.filter((task) => {
        if (getPath(task, "completed") === true) return false;
        const due = parseDate(getPath(task, "due_date"));
        return Boolean(due && due.getTime() < now);
      });

      const result = aggregate(
        items,
        [{ field: "user_id", as: "assigned_user_id" }],
        [
          { op: "count", as: "tasks" },
          { op: "distinct", field: "contact.id", as: "contacts_touched" },
        ],
        { sortBy: "tasks", sortDir: "desc", limit },
      );

      return {
        report: "tasks",
        source: { endpoint: endpoint.id, recordsFetched: items.length, truncated },
        headline: {
          total_tasks: items.length,
          completed: items.filter((task) => getPath(task, "completed") === true).length,
          overdue: overdue.length,
          next_due: overdue.length
            ? bucketDate(getPath(overdue[0], "due_date"), "day")
            : null,
        },
        rows: result.groups,
        notes,
      };
    }

    default: {
      const exhaustive: never = options.report;
      throw new Error(`Unknown report: ${String(exhaustive)}`);
    }
  }
}
