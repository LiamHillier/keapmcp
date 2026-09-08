/**
 * Grouping, filtering and metric computation over records returned by any Keap
 * list endpoint. This is what turns "revenue by month last year" into an answer
 * without the model having to page through thousands of raw orders.
 */

export type Bucket = "none" | "day" | "week" | "month" | "quarter" | "year" | "hour" | "dow";

export type Operator =
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
  | "contains" | "not_contains" | "starts_with"
  | "in" | "not_in" | "exists" | "not_exists";

export interface Filter {
  field: string;
  op: Operator;
  value?: unknown;
}

export interface Metric {
  /** count needs no field; every other op requires one. */
  op: "count" | "sum" | "avg" | "min" | "max" | "distinct";
  field?: string;
  as?: string;
}

/**
 * Read a dotted path out of a record. Supports array hops: "order_items.price"
 * over an array of items yields every price, which sum/avg then fold together.
 */
export function getPath(record: unknown, path: string): unknown {
  if (!path) return record;
  let current: unknown = record;
  for (const rawSegment of path.split(".")) {
    const segment = rawSegment.trim();
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (Number.isInteger(index)) {
        current = current[index];
        continue;
      }
      const collected = current
        .map((item) => getPath(item, segment))
        .filter((value) => value !== undefined);
      current = collected.length ? collected.flat() : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

interface MoneyLike {
  amount?: number | string;
  currency_code?: string;
  formatted_amount?: string;
}

function isMoney(value: unknown): value is MoneyLike {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "amount" in (value as object) &&
    "currency_code" in (value as object)
  );
}

/**
 * Keap's v2 API returns money as {amount, currency_code, formatted_amount},
 * where `amount` is in minor units (7500 = $75.00). v1 returns plain majors.
 * `formatted_amount` is the reliable source for major units because it is
 * already currency-aware (zero-decimal currencies included).
 */
export function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.map(toNumber).filter((n): n is number => n !== undefined);
    return parts.length ? parts.reduce((a, b) => a + b, 0) : undefined;
  }
  if (isMoney(value)) {
    if (typeof value.formatted_amount === "string") {
      const cleaned = value.formatted_amount.replace(/[^0-9.\-]/g, "");
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed) && cleaned !== "") {
        return value.formatted_amount.trim().startsWith("-") ? -Math.abs(parsed) : parsed;
      }
    }
    const raw = toNumber(value.amount);
    return raw === undefined ? undefined : raw / 100;
  }
  return undefined;
}

/** Currency code carried alongside a money value, when there is one. */
export function currencyOf(value: unknown): string | undefined {
  return isMoney(value) && typeof value.currency_code === "string" ? value.currency_code : undefined;
}

/**
 * Keap's v1 API accepts exactly one date format — `YYYY-MM-DDTHH:mm:ss.SSSZ` —
 * and rejects both bare dates and second-precision ISO strings with a 400.
 * A bare `until` date is widened to the end of that day, since "until
 * 2026-12-31" means through the 31st, not up to its midnight.
 */
export function normaliseDateBound(value: unknown, bound: "since" | "until"): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim();
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = parseDate(bareDate && bound === "until" ? `${raw}T23:59:59.999Z` : raw);
  return date ? date.toISOString() : undefined;
}

export function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value !== "string" || !value.trim()) return undefined;
  // Bare "2019-01-21" is parsed as UTC midnight by Date, which is what we want.
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function bucketDate(value: unknown, bucket: Bucket): string | undefined {
  if (bucket === "none") return undefined;
  const date = parseDate(value);
  if (!date) return undefined;
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, "0");

  switch (bucket) {
    case "year":
      return String(year);
    case "quarter":
      return `${year}-Q${Math.floor(month / 3) + 1}`;
    case "month":
      return `${year}-${pad(month + 1)}`;
    case "week": {
      // ISO week: Thursday of the current week determines the year.
      const target = new Date(Date.UTC(year, month, date.getUTCDate()));
      const day = (target.getUTCDay() + 6) % 7;
      target.setUTCDate(target.getUTCDate() - day + 3);
      const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
      const week =
        1 +
        Math.round(
          (target.getTime() - firstThursday.getTime()) / 604800000 -
            ((firstThursday.getUTCDay() + 6) % 7) / 7,
        );
      return `${target.getUTCFullYear()}-W${pad(week)}`;
    }
    case "day":
      return `${year}-${pad(month + 1)}-${pad(date.getUTCDate())}`;
    case "hour":
      return `${year}-${pad(month + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:00Z`;
    case "dow":
      return DOW[date.getUTCDay()];
    default:
      return undefined;
  }
}

function compare(actual: unknown, op: Operator, expected: unknown): boolean {
  switch (op) {
    case "exists":
      return actual !== undefined && actual !== null && actual !== "";
    case "not_exists":
      return actual === undefined || actual === null || actual === "";
    case "in":
    case "not_in": {
      const list = (Array.isArray(expected) ? expected : [expected]).map((v) => String(v).toLowerCase());
      const hit = list.includes(String(actual).toLowerCase());
      return op === "in" ? hit : !hit;
    }
    case "contains":
    case "not_contains": {
      const hit = String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
      return op === "contains" ? hit : !hit;
    }
    case "starts_with":
      return String(actual ?? "").toLowerCase().startsWith(String(expected ?? "").toLowerCase());
    default:
      break;
  }

  // Numeric comparison when both sides look numeric, date comparison when both
  // parse as dates, string comparison otherwise.
  const actualNum = toNumber(actual);
  const expectedNum = toNumber(expected);
  if (actualNum !== undefined && expectedNum !== undefined && typeof expected !== "string") {
    return numericCompare(actualNum, op, expectedNum);
  }

  const actualDate = parseDate(actual);
  const expectedDate = parseDate(expected);
  if (actualDate && expectedDate && typeof expected === "string" && /\d{4}-\d{2}/.test(expected)) {
    return numericCompare(actualDate.getTime(), op, expectedDate.getTime());
  }

  if (actualNum !== undefined && expectedNum !== undefined) {
    return numericCompare(actualNum, op, expectedNum);
  }

  const a = String(actual ?? "").toLowerCase();
  const b = String(expected ?? "").toLowerCase();
  switch (op) {
    case "eq": return a === b;
    case "ne": return a !== b;
    case "gt": return a > b;
    case "gte": return a >= b;
    case "lt": return a < b;
    case "lte": return a <= b;
    default: return false;
  }
}

function numericCompare(a: number, op: Operator, b: number): boolean {
  switch (op) {
    case "eq": return a === b;
    case "ne": return a !== b;
    case "gt": return a > b;
    case "gte": return a >= b;
    case "lt": return a < b;
    case "lte": return a <= b;
    default: return false;
  }
}

export function applyFilters(records: unknown[], filters: Filter[]): unknown[] {
  if (!filters.length) return records;
  return records.filter((record) =>
    filters.every((filter) => compare(getPath(record, filter.field), filter.op, filter.value)),
  );
}

export interface GroupSpec {
  field: string;
  bucket?: Bucket;
  as?: string;
}

export interface AggregateResult {
  groups: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  groupCount: number;
  recordsConsidered: number;
  currencies?: string[];
}

function metricName(metric: Metric): string {
  if (metric.as) return metric.as;
  if (metric.op === "count") return "count";
  return `${metric.op}_${(metric.field || "value").replace(/\./g, "_")}`;
}

export function aggregate(
  records: unknown[],
  groupBy: GroupSpec[],
  metrics: Metric[],
  options: { sortBy?: string; sortDir?: "asc" | "desc"; limit?: number } = {},
): AggregateResult {
  const effectiveMetrics = metrics.length ? metrics : [{ op: "count" as const }];
  const currencies = new Set<string>();

  interface Accumulator {
    keys: Record<string, unknown>;
    count: number;
    sums: Record<string, number>;
    counts: Record<string, number>;
    mins: Record<string, number>;
    maxs: Record<string, number>;
    distincts: Record<string, Set<string>>;
  }

  const buckets = new Map<string, Accumulator>();

  for (const record of records) {
    const keys: Record<string, unknown> = {};
    const keyParts: string[] = [];
    for (const spec of groupBy) {
      const raw = getPath(record, spec.field);
      const label = spec.as || spec.field;
      const value =
        spec.bucket && spec.bucket !== "none"
          ? bucketDate(raw, spec.bucket) ?? "(no date)"
          : normaliseKey(raw);
      keys[label] = value;
      keyParts.push(String(value));
    }
    const key = keyParts.join(" ") || "__all__";

    let acc = buckets.get(key);
    if (!acc) {
      acc = { keys, count: 0, sums: {}, counts: {}, mins: {}, maxs: {}, distincts: {} };
      buckets.set(key, acc);
    }
    acc.count++;

    for (const metric of effectiveMetrics) {
      if (metric.op === "count") continue;
      const name = metricName(metric);
      const raw = getPath(record, metric.field || "");
      if (metric.op === "distinct") {
        (acc.distincts[name] ??= new Set()).add(normaliseKey(raw) as string);
        continue;
      }
      const currency = currencyOf(raw);
      if (currency) currencies.add(currency);
      const value = toNumber(raw);
      if (value === undefined) continue;
      acc.sums[name] = (acc.sums[name] ?? 0) + value;
      acc.counts[name] = (acc.counts[name] ?? 0) + 1;
      acc.mins[name] = acc.mins[name] === undefined ? value : Math.min(acc.mins[name], value);
      acc.maxs[name] = acc.maxs[name] === undefined ? value : Math.max(acc.maxs[name], value);
    }
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const acc of buckets.values()) {
    const row: Record<string, unknown> = { ...acc.keys };
    for (const metric of effectiveMetrics) {
      const name = metricName(metric);
      switch (metric.op) {
        case "count":
          row[name] = acc.count;
          break;
        case "sum":
          row[name] = round(acc.sums[name] ?? 0);
          break;
        case "avg":
          row[name] = acc.counts[name] ? round(acc.sums[name] / acc.counts[name]) : null;
          break;
        case "min":
          row[name] = acc.mins[name] ?? null;
          break;
        case "max":
          row[name] = acc.maxs[name] ?? null;
          break;
        case "distinct":
          row[name] = acc.distincts[name]?.size ?? 0;
          break;
      }
    }
    rows.push(row);
  }

  const defaultSort =
    options.sortBy ||
    (groupBy.some((g) => g.bucket && g.bucket !== "none")
      ? groupBy[0].as || groupBy[0].field
      : metricName(effectiveMetrics[0]));
  const dir = options.sortDir || (defaultSort === (groupBy[0]?.as || groupBy[0]?.field) ? "asc" : "desc");

  rows.sort((a, b) => {
    const av = a[defaultSort];
    const bv = b[defaultSort];
    const an = typeof av === "number" ? av : undefined;
    const bn = typeof bv === "number" ? bv : undefined;
    let cmp: number;
    if (an !== undefined && bn !== undefined) cmp = an - bn;
    else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
    return dir === "asc" ? cmp : -cmp;
  });

  const totals: Record<string, number> = { records: records.length };
  for (const metric of effectiveMetrics) {
    const name = metricName(metric);
    if (metric.op === "count") {
      totals[name] = records.length;
    } else if (metric.op === "sum") {
      totals[name] = round(rows.reduce((sum, row) => sum + (Number(row[name]) || 0), 0));
    } else if (metric.op === "avg") {
      const values = rows.map((r) => Number(r[name])).filter((n) => Number.isFinite(n));
      totals[name] = values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
    }
  }

  return {
    groups: options.limit ? rows.slice(0, options.limit) : rows,
    totals,
    groupCount: rows.length,
    recordsConsidered: records.length,
    currencies: currencies.size ? [...currencies].sort() : undefined,
  };
}

function normaliseKey(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return "(none)";
  if (Array.isArray(value)) return value.map((v) => normaliseKey(v)).join(", ") || "(none)";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Nested entities are far more useful keyed by a human-readable field.
    for (const key of ["name", "title", "label", "email", "id"]) {
      if (obj[key] !== undefined && typeof obj[key] !== "object") return String(obj[key]);
    }
    return JSON.stringify(value).slice(0, 80);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Keep only selected dotted paths from each record, to control response size. */
export function project(records: unknown[], fields: string[]): unknown[] {
  if (!fields.length) return records;
  return records.map((record) => {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const value = getPath(record, field);
      if (value !== undefined) out[field] = value;
    }
    return out;
  });
}
