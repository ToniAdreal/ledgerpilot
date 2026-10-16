/**
 * Ask-the-grid — deterministic plain-language → AG Grid filter models.
 *
 * CONCEPT.md §3.3: a plain-language query ("show unpaid invoices over
 * $200 from this month") is compiled by the deterministic parser into
 * a *validated* AG Grid filter model, and the grid visibly
 * reconfigures. No LLM, no network, no keys — the same query with the
 * same reference date always produces the same model.
 *
 * Safety shape (the "validated" half of the feature):
 * - The parser only ever emits models built from the column specs in
 *   this file (known columns, matching filterType, whitelisted
 *   comparison types, finite amounts, ISO dates).
 * - Every emitted model is passed through `validateAskFilterModels`
 *   before it is returned, and the same validator is exported so the
 *   UI (or a future endpoint) can re-check a model before handing it
 *   to `api.setFilterModel(...)`.
 * - A query with no recognizable condition throws `AskParseError`
 *   with guidance — the grid is never silently cleared or given a
 *   model the parser did not understand.
 * - Amount captures are checked at conversion: a digit-less
 *   (commas-only) capture is refused with `AskParseError` guidance,
 *   never compiled into a silent 0.00 filter; a non-finite
 *   conversion (unreachable under today's query-length cap) is
 *   refused the same way rather than surfaced as an internal
 *   validation failure.
 */

export class AskParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskParseError";
  }
}

/* ------------------------------------------------------------------ */
/* Filter-model shapes (AG Grid Community provided filters)            */
/* ------------------------------------------------------------------ */

export type GridFilterType = "text" | "number" | "date";

export interface SimpleFilterModel {
  filterType: GridFilterType;
  type: string;
  filter?: string | number;
  filterTo?: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface CombinedFilterModel {
  filterType: GridFilterType;
  operator: "OR" | "AND";
  conditions: SimpleFilterModel[];
}

export type ColumnFilterModel = SimpleFilterModel | CombinedFilterModel;

/** One grid's filter model: column field → column filter model. */
export type GridFilterModel = Record<string, ColumnFilterModel>;

export type AskTarget = "invoices" | "orders" | "payouts" | "activity";

export const ASK_TARGETS: AskTarget[] = ["invoices", "orders", "payouts", "activity"];

export const TARGET_LABELS: Record<AskTarget, string> = {
  invoices: "Invoices",
  orders: "Orders / Checkout",
  payouts: "Payouts",
  activity: "Agent Activity & Webhook Audit",
};

/* ------------------------------------------------------------------ */
/* Column specs — the validation whitelist                             */
/*                                                                     */
/* Fields must match the ColDefs in src/app/console-client.tsx.        */
/* `amountValue` / `dueDate` etc. are the row-model fields the grids   */
/* filter on, never the formatted display strings.                     */
/* ------------------------------------------------------------------ */

export const COLUMN_SPECS: Record<AskTarget, Record<string, GridFilterType>> = {
  invoices: {
    invoiceNumber: "text",
    recipientName: "text",
    recipientEmail: "text",
    status: "text",
    currency: "text",
    amountValue: "number",
    dueValue: "number",
    dueDate: "date",
  },
  orders: {
    id: "text",
    description: "text",
    referenceId: "text",
    status: "text",
    currency: "text",
    amountValue: "number",
    captureId: "text",
    captureStatus: "text",
  },
  payouts: {
    recipientName: "text",
    recipientEmail: "text",
    status: "text",
    currency: "text",
    amountValue: "number",
    note: "text",
    batchId: "text",
    timeCreated: "date",
  },
  activity: {
    kind: "text",
    planId: "text",
    eventId: "text",
    summary: "text",
    createdAt: "date",
  },
};

/** The date column a "this month / today" condition lands on, per grid. Orders rows carry no date. */
const DATE_FIELD: Partial<Record<AskTarget, string>> = {
  invoices: "dueDate",
  payouts: "timeCreated",
  activity: "createdAt",
};

/** The free-text column a quoted keyword lands on, per grid. */
const KEYWORD_FIELD: Record<AskTarget, string> = {
  invoices: "recipientName",
  orders: "description",
  payouts: "recipientName",
  activity: "summary",
};

/** The recipient column, per grid (orders/activity have none — the keyword field is used instead). */
const RECIPIENT_FIELD: Partial<Record<AskTarget, string>> = {
  invoices: "recipientName",
  payouts: "recipientName",
};

const ALLOWED_TYPES: Record<GridFilterType, ReadonlySet<string>> = {
  text: new Set(["equals", "notEqual", "contains", "notContains", "startsWith", "endsWith", "blank", "notBlank"]),
  number: new Set([
    "equals",
    "notEqual",
    "lessThan",
    "lessThanOrEqual",
    "greaterThan",
    "greaterThanOrEqual",
    "inRange",
    "blank",
    "notBlank",
  ]),
  date: new Set(["equals", "notEqual", "lessThan", "greaterThan", "inRange", "blank", "notBlank"]),
};

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateSimple(model: unknown, target: AskTarget, field: string, filterType: GridFilterType): string | null {
  if (!isRecord(model)) return `${target}.${field}: filter model must be an object`;
  if (model.filterType !== filterType) {
    return `${target}.${field}: filterType must be "${filterType}" for this column, got ${JSON.stringify(model.filterType)}`;
  }
  if (typeof model.type !== "string" || !ALLOWED_TYPES[filterType].has(model.type)) {
    return `${target}.${field}: comparison type ${JSON.stringify(model.type)} is not allowed for a ${filterType} filter`;
  }
  if (filterType === "text" && model.type !== "blank" && model.type !== "notBlank") {
    if (typeof model.filter !== "string" || model.filter.length === 0) {
      return `${target}.${field}: text filter needs a non-empty string "filter" value`;
    }
  }
  if (filterType === "number" && model.type !== "blank" && model.type !== "notBlank") {
    if (typeof model.filter !== "number" || !Number.isFinite(model.filter)) {
      return `${target}.${field}: number filter needs a finite numeric "filter" value`;
    }
    if (model.type === "inRange" && (typeof model.filterTo !== "number" || !Number.isFinite(model.filterTo))) {
      return `${target}.${field}: inRange number filter needs a finite numeric "filterTo" value`;
    }
  }
  if (filterType === "date" && model.type !== "blank" && model.type !== "notBlank") {
    if (typeof model.dateFrom !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(model.dateFrom)) {
      return `${target}.${field}: date filter needs an ISO "dateFrom" value`;
    }
    if (model.type === "inRange" && (typeof model.dateTo !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(model.dateTo))) {
      return `${target}.${field}: inRange date filter needs an ISO "dateTo" value`;
    }
  }
  return null;
}

function validateColumn(model: unknown, target: AskTarget, field: string): string | null {
  const filterType = COLUMN_SPECS[target][field];
  if (!filterType) return `${target}.${field}: unknown column for the ${target} grid`;
  if (!isRecord(model)) return `${target}.${field}: filter model must be an object`;
  if (model.operator !== undefined) {
    if (model.operator !== "OR" && model.operator !== "AND") {
      return `${target}.${field}: combined filter operator must be "OR" or "AND"`;
    }
    if (!Array.isArray(model.conditions) || model.conditions.length === 0) {
      return `${target}.${field}: combined filter needs at least one condition`;
    }
    for (const condition of model.conditions) {
      const err = validateSimple(condition, target, field, filterType);
      if (err) return err;
    }
    return null;
  }
  return validateSimple(model, target, field, filterType);
}

/**
 * Re-check a set of grid filter models against the column specs.
 * Returns a list of problems (empty = valid). The parser runs every
 * model it emits through this; callers applying a model from anywhere
 * else should do the same before `api.setFilterModel(...)`.
 */
export function validateAskFilterModels(models: Partial<Record<AskTarget, GridFilterModel>>): string[] {
  const problems: string[] = [];
  for (const [target, model] of Object.entries(models)) {
    if (!ASK_TARGETS.includes(target as AskTarget)) {
      problems.push(`${target}: unknown grid`);
      continue;
    }
    if (!isRecord(model)) {
      problems.push(`${target}: filter model must be an object`);
      continue;
    }
    for (const [field, columnModel] of Object.entries(model)) {
      const err = validateColumn(columnModel, target as AskTarget, field);
      if (err) problems.push(err);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* Status vocabulary                                                   */
/* ------------------------------------------------------------------ */

const OPEN_INVOICE_STATUSES = ["SENT", "SCHEDULED", "PARTIALLY_PAID"];

/**
 * Each phrase maps to the status values it means *per grid* — "paid"
 * is PAID on invoices, COMPLETED on orders, SUCCESS on payouts.
 * Phrases are matched longest-first so "partially paid" wins over
 * "paid".
 */
const STATUS_PHRASES: Array<{
  pattern: RegExp;
  label: string;
  perTarget: Partial<Record<AskTarget, string[]>>;
}> = [
  {
    pattern: /\bpartially[\s-]+paid\b|\bpartial\b/,
    label: "partially paid",
    perTarget: { invoices: ["PARTIALLY_PAID"] },
  },
  {
    pattern: /\bunpaid\b|\bstill\s+owed\b|\boutstanding\b/,
    label: "unpaid",
    perTarget: {
      invoices: OPEN_INVOICE_STATUSES,
      orders: ["CREATED", "SAVED", "APPROVED"],
      payouts: ["PENDING", "UNCLAIMED"],
    },
  },
  {
    pattern: /\bpaid\b|\bcollected\b/,
    label: "paid",
    perTarget: { invoices: ["PAID", "MARKED_AS_PAID"], orders: ["COMPLETED"], payouts: ["SUCCESS"] },
  },
  { pattern: /\bcompleted\b/, label: "completed", perTarget: { orders: ["COMPLETED"] } },
  { pattern: /\bsucceeded\b|\bsuccessful\b|\bsuccess\b/, label: "succeeded", perTarget: { payouts: ["SUCCESS"] } },
  { pattern: /\bsent\b/, label: "sent", perTarget: { invoices: ["SENT"], payouts: ["SUCCESS"] } },
  { pattern: /\bdraft\b/, label: "draft", perTarget: { invoices: ["DRAFT"] } },
  { pattern: /\bscheduled\b/, label: "scheduled", perTarget: { invoices: ["SCHEDULED"] } },
  { pattern: /\bcancelled\b|\bcanceled\b/, label: "cancelled", perTarget: { invoices: ["CANCELLED"] } },
  { pattern: /\brefunded\b/, label: "refunded", perTarget: { invoices: ["REFUNDED"] } },
  { pattern: /\bcreated\b/, label: "created", perTarget: { orders: ["CREATED"] } },
  { pattern: /\bapproved\b/, label: "approved", perTarget: { orders: ["APPROVED"] } },
  { pattern: /\bvoided\b/, label: "voided", perTarget: { orders: ["VOIDED"] } },
  { pattern: /\bfailed\b|\bfailure\b/, label: "failed", perTarget: { payouts: ["FAILED"] } },
  { pattern: /\bpending\b/, label: "pending", perTarget: { payouts: ["PENDING"] } },
  { pattern: /\bunclaimed\b/, label: "unclaimed", perTarget: { payouts: ["UNCLAIMED"] } },
  { pattern: /\breturned\b/, label: "returned", perTarget: { payouts: ["RETURNED"] } },
  { pattern: /\bblocked\b/, label: "blocked", perTarget: { payouts: ["BLOCKED"] } },
];

/* ------------------------------------------------------------------ */
/* Parsed conditions (grid-agnostic)                                   */
/* ------------------------------------------------------------------ */

type AmountOp = "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual" | "equals" | "inRange";

interface AmountCondition {
  op: AmountOp;
  value: number;
  valueTo?: number;
  currency?: string;
  label: string;
}

interface DateCondition {
  label: string;
  model: SimpleFilterModel;
}

interface ParsedConditions {
  status?: { label: string; perTarget: Partial<Record<AskTarget, string[]>> };
  amount?: AmountCondition;
  recipient?: string;
  keyword?: string;
  overdue: boolean;
  date?: DateCondition;
  activityKind?: string;
}

const OP_LABELS: Record<AmountOp, string> = {
  greaterThan: "over",
  greaterThanOrEqual: "at least",
  lessThan: "under",
  lessThanOrEqual: "at most",
  equals: "exactly",
  inRange: "between",
};

const SYMBOL_CURRENCIES: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

function parseAmount(text: string): AmountCondition | undefined {
  // Amount hygiene (mirrors the brief parser's amount rule): the
  // amount patterns below admit commas as grouping separators, so a
  // commas-only capture (``over ,,,``) strips to an empty string and
  // Number("") is 0 — a silent ``over 0.00`` filter the user never
  // asked for. It is refused here with AskParseError guidance, at
  // the one conversion point every amount form (between /
  // comparison / or-more) passes through. The finite check beside
  // it is defence in depth: the 300-character query cap keeps every
  // reachable digit string finite today, but if that cap ever
  // changes, an overflowing digit string would become Infinity and
  // surface as a misleading internal-validation failure instead of
  // this user-facing refusal. A large but finite amount is NOT
  // refused — a filter is not a money movement and carries no cap.
  const money = (symbol: string | undefined, num: string, code: string | undefined): { value: number; currency?: string } => {
    if (!/\d/.test(num)) {
      throw new AskParseError(
        `That amount ("${num}") has no digits — try an amount like "over $200" or "between $50 and $150".`,
      );
    }
    const value = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      throw new AskParseError(
        "That amount is too large to filter by — try a smaller amount like \"over $200\".",
      );
    }
    return {
      value,
      currency: (symbol ? SYMBOL_CURRENCIES[symbol] : undefined) ?? code?.toUpperCase(),
    };
  };

  const between = text.match(
    /between\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?\s+and\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?/i,
  );
  if (between) {
    const a = money(between[1], between[2]!, between[3]);
    const b = money(between[4] ?? between[1], between[5]!, between[6] ?? between[3]);
    const [lo, hi] = a.value <= b.value ? [a, b] : [b, a];
    return {
      op: "inRange",
      value: lo.value,
      valueTo: hi.value,
      currency: lo.currency ?? hi.currency,
      label: `between ${lo.currency ?? ""} ${lo.value.toFixed(2)} and ${hi.value.toFixed(2)}`.trim(),
    };
  }

  const patterns: Array<{ re: RegExp; op: AmountOp }> = [
    { re: /(?:over|above|more\s+than|greater\s+than)\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?/i, op: "greaterThan" },
    { re: /(?:at\s+least|min(?:imum)?)\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?/i, op: "greaterThanOrEqual" },
    { re: /(?:under|below|less\s+than|fewer\s+than)\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?/i, op: "lessThan" },
    { re: /(?:at\s+most|max(?:imum)?)\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?/i, op: "lessThanOrEqual" },
    { re: /(?:exactly|equals?|=)\s*([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?/i, op: "equals" },
  ];
  for (const { re, op } of patterns) {
    const m = text.match(re);
    if (m) {
      const amount = money(m[1], m[2]!, m[3]);
      return {
        op,
        value: amount.value,
        currency: amount.currency,
        label: `${OP_LABELS[op]} ${amount.currency ?? ""} ${amount.value.toFixed(2)}`.trim(),
      };
    }
  }
  // "… $200 or more" / "… $200 or less" (symbol mandatory in this form).
  const orForm = text.match(/([$€£])\s*([\d,]+(?:\.\d{1,2})?)\s+or\s+(more|less)/i);
  if (orForm) {
    const amount = money(orForm[1], orForm[2]!, undefined);
    const op: AmountOp = orForm[3]!.toLowerCase() === "more" ? "greaterThanOrEqual" : "lessThanOrEqual";
    return {
      op,
      value: amount.value,
      currency: amount.currency,
      label: `${OP_LABELS[op]} ${amount.currency ?? ""} ${amount.value.toFixed(2)}`.trim(),
    };
  }
  return undefined;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDateCondition(text: string, now: Date): DateCondition | undefined {
  const lower = text.toLowerCase();
  const today = fmtDate(now);
  if (/\btoday\b/.test(lower)) {
    return { label: "today", model: { filterType: "date", type: "equals", dateFrom: today } };
  }
  if (/\bthis\s+month\b/.test(lower)) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return {
      label: "this month",
      model: { filterType: "date", type: "inRange", dateFrom: fmtDate(from), dateTo: fmtDate(to) },
    };
  }
  if (/\blast\s+month\b/.test(lower)) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return {
      label: "last month",
      model: { filterType: "date", type: "inRange", dateFrom: fmtDate(from), dateTo: fmtDate(to) },
    };
  }
  if (/\bthis\s+week\b/.test(lower)) {
    // ISO week: Monday through Sunday containing `now`.
    const day = now.getUTCDay(); // 0 = Sunday
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
      label: "this week",
      model: { filterType: "date", type: "inRange", dateFrom: fmtDate(monday), dateTo: fmtDate(sunday) },
    };
  }
  return undefined;
}

const RECIPIENT_STOPWORDS = new Set([
  "This",
  "Last",
  "The",
  "All",
  "Show",
  "List",
  "Find",
  "Everything",
  "Invoice",
  "Invoices",
  "Order",
  "Orders",
  "Payout",
  "Payouts",
]);

function parseRecipient(text: string): string | undefined {
  const possessive = text.match(/\b([A-Z][a-z]+)'s\b/);
  if (possessive && !RECIPIENT_STOPWORDS.has(possessive[1]!)) return possessive[1];
  const prep = text.match(/\b(?:from|to|for)\s+([A-Z][a-z]+)\b/);
  if (prep && !RECIPIENT_STOPWORDS.has(prep[1]!)) return prep[1];
  return undefined;
}

function parseConditions(text: string, now: Date): ParsedConditions {
  const conditions: ParsedConditions = { overdue: /\boverdue\b/i.test(text) };

  for (const phrase of STATUS_PHRASES) {
    if (phrase.pattern.test(text)) {
      conditions.status = { label: phrase.label, perTarget: phrase.perTarget };
      break;
    }
  }
  // "overdue" is its own condition (open status + due date in the past),
  // not a status value — clear a coincidental status match on "sent" etc.
  // only when overdue is the *sole* status-ish word; the builder merges both.

  conditions.amount = parseAmount(text);
  conditions.date = parseDateCondition(text, now);
  conditions.recipient = parseRecipient(text);

  const quoted = text.match(/"([^"]+)"/) ?? text.match(/'([^']+)'/);
  if (quoted) conditions.keyword = quoted[1]!.trim();

  if (/\bwebhooks?\b/.test(text.toLowerCase())) conditions.activityKind = "webhook";
  else if (/\bapprovals?\b/.test(text.toLowerCase())) conditions.activityKind = "approval";
  else if (/\bpaypal\s+calls?\b/.test(text.toLowerCase())) conditions.activityKind = "paypal_call";

  return conditions;
}

function hasAnyCondition(c: ParsedConditions): boolean {
  return Boolean(c.status || c.amount || c.recipient || c.keyword || c.date || c.activityKind || c.overdue);
}

/* ------------------------------------------------------------------ */
/* Target detection                                                    */
/* ------------------------------------------------------------------ */

function detectTargets(text: string): { targets: AskTarget[]; explicit: boolean } {
  const lower = text.toLowerCase();
  const found: AskTarget[] = [];
  if (/\binvoices?\b/.test(lower)) found.push("invoices");
  if (/\borders?\b|\bcheckout\b/.test(lower)) found.push("orders");
  if (/\bpayouts?\b/.test(lower)) found.push("payouts");
  if (/\bactivit\w*\b|\baudit\b|\bwebhooks?\b|\bevents?\b|\blog\b/.test(lower)) found.push("activity");
  if (found.length > 0) return { targets: found, explicit: true };
  return { targets: [...ASK_TARGETS], explicit: false };
}

/* ------------------------------------------------------------------ */
/* Model building                                                      */
/* ------------------------------------------------------------------ */

function statusModel(values: string[]): ColumnFilterModel {
  if (values.length === 1) return { filterType: "text", type: "equals", filter: values[0] };
  return {
    filterType: "text",
    operator: "OR",
    conditions: values.map((v) => ({ filterType: "text", type: "equals", filter: v }) as SimpleFilterModel),
  };
}

function buildForTarget(
  target: AskTarget,
  c: ParsedConditions,
  now: Date,
  notes: string[],
): { model: GridFilterModel; explanations: string[] } {
  const model: GridFilterModel = {};
  const explanations: string[] = [];
  const label = TARGET_LABELS[target];

  if (c.overdue && target === "invoices") {
    model.status = statusModel(OPEN_INVOICE_STATUSES);
    model.dueDate = { filterType: "date", type: "lessThan", dateFrom: fmtDate(now) };
    explanations.push(`${label}: overdue — open status (SENT, SCHEDULED, or PARTIALLY_PAID) and due date before ${fmtDate(now)}`);
  } else if (c.status) {
    const values = c.status.perTarget[target];
    if (values) {
      // Merge with an overdue status model if both were requested.
      model.status = statusModel(values);
      explanations.push(`${label}: status is ${values.join(", ")} (${c.status.label})`);
    }
  }
  if (c.overdue && target === "invoices" && c.status?.perTarget.invoices) {
    // Both an explicit status and "overdue": keep the explicit status,
    // add the past-due date leg (the read model's overdue definition).
    model.dueDate = { filterType: "date", type: "lessThan", dateFrom: fmtDate(now) };
    explanations.push(`${label}: due date before ${fmtDate(now)} (overdue)`);
  }
  if (c.overdue && target !== "invoices") {
    notes.push(`"Overdue" only applies to the Invoices grid — skipped for ${label}.`);
  }

  if (c.amount) {
    if (COLUMN_SPECS[target].amountValue) {
      const m: SimpleFilterModel =
        c.amount.op === "inRange"
          ? { filterType: "number", type: "inRange", filter: c.amount.value, filterTo: c.amount.valueTo }
          : { filterType: "number", type: c.amount.op, filter: c.amount.value };
      model.amountValue = m;
      explanations.push(`${label}: amount ${c.amount.label}`);
      if (c.amount.currency) {
        model.currency = { filterType: "text", type: "equals", filter: c.amount.currency };
        explanations.push(`${label}: currency is ${c.amount.currency}`);
      }
    } else {
      notes.push(`${label} has no amount column — amount condition skipped there.`);
    }
  }

  if (c.recipient) {
    const field = RECIPIENT_FIELD[target] ?? KEYWORD_FIELD[target];
    model[field] = { filterType: "text", type: "contains", filter: c.recipient };
    explanations.push(
      target === "invoices" || target === "payouts"
        ? `${label}: recipient contains "${c.recipient}"`
        : `${label}: ${field} contains "${c.recipient}"`,
    );
  }

  if (c.keyword) {
    const field = KEYWORD_FIELD[target];
    if (!model[field]) {
      model[field] = { filterType: "text", type: "contains", filter: c.keyword };
      explanations.push(`${label}: ${field} contains "${c.keyword}"`);
    }
  }

  if (c.date) {
    const field = DATE_FIELD[target];
    if (field) {
      // An overdue due-date leg already occupies the invoices date column.
      if (!(target === "invoices" && model.dueDate)) {
        model[field] = { ...c.date.model };
        explanations.push(`${label}: ${field} is ${c.date.label} (${c.date.model.dateFrom}${c.date.model.dateTo ? ` → ${c.date.model.dateTo}` : ""})`);
      }
    } else {
      notes.push(`${label} rows carry no date — the "${c.date.label}" condition is skipped there.`);
    }
  }

  if (target === "activity" && c.activityKind) {
    model.kind = { filterType: "text", type: "equals", filter: c.activityKind };
    explanations.push(`${label}: kind is ${c.activityKind}`);
  }

  return { model, explanations };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface AskOptions {
  /** Reference "now" for relative dates (overdue / this month / …) — injectable for deterministic tests. */
  now?: Date;
}

export interface AskResult {
  /** The query as typed (trimmed). */
  query: string;
  /** Grids the query applies to (only grids that received a filter are listed). */
  targets: AskTarget[];
  /** Validated AG Grid filter models, keyed by grid. Pass to `api.setFilterModel(...)`. */
  models: Partial<Record<AskTarget, GridFilterModel>>;
  /** One human line per applied condition, for the "what just happened" readout. */
  explanations: string[];
  /** Non-fatal notes (a condition that does not apply to one of the grids). */
  notes: string[];
  /** One-line summary: "Invoices: status is … · amount over …". */
  summary: string;
}

export const EXAMPLE_ASKS: Array<{ label: string; query: string }> = [
  { label: "Unpaid invoices over $200", query: "Show unpaid invoices over $200" },
  { label: "Overdue invoices", query: "Show overdue invoices" },
  { label: "Everything still unpaid", query: "Show everything still unpaid" },
  { label: "Payouts to Marco", query: "Show payouts to Marco" },
  { label: "Paid invoices due this month", query: "Show paid invoices due this month" },
  { label: "Webhook events", query: "Show webhook events" },
];

export function parseAskQuery(input: string, options: AskOptions = {}): AskResult {
  const now = options.now ?? new Date();
  const query = input.trim();
  if (!query) {
    throw new AskParseError(
      "Ask a question first — e.g. “Show unpaid invoices over $200” or “Show everything still unpaid.”",
    );
  }
  if (query.length > 300) {
    throw new AskParseError(`Query is too long (${query.length}/300 characters). Keep it to the filter you need.`);
  }

  const conditions = parseConditions(query, now);
  if (!hasAnyCondition(conditions)) {
    throw new AskParseError(
      `No filter found in: "${query}". Try a status (unpaid, paid, overdue, failed), an amount (over $200, between $50 and $150), a person (to Marco), or a date (this month, today).`,
    );
  }

  const { targets: wanted, explicit } = detectTargets(query);
  const models: Partial<Record<AskTarget, GridFilterModel>> = {};
  const explanations: string[] = [];
  const notes: string[] = [];
  const applied: AskTarget[] = [];

  for (const target of wanted) {
    const { model, explanations: lines } = buildForTarget(target, conditions, now, notes);
    if (Object.keys(model).length > 0) {
      models[target] = model;
      applied.push(target);
      explanations.push(...lines);
    }
  }

  if (applied.length === 0) {
    throw new AskParseError(
      `That filter does not apply to the ${wanted.map((t) => TARGET_LABELS[t]).join(", ")} grid${wanted.length === 1 ? "" : "s"} — e.g. amounts and statuses filter Invoices, Orders, and Payouts; webhook kinds filter the Activity grid.`,
    );
  }
  if (explicit && wanted.some((t) => !applied.includes(t))) {
    for (const t of wanted) {
      if (!applied.includes(t)) notes.push(`No part of that query applied to ${TARGET_LABELS[t]} — left unfiltered.`);
    }
  }

  const problems = validateAskFilterModels(models);
  if (problems.length > 0) {
    // A parser bug, not a user error: fail loudly rather than hand the grid a bad model.
    throw new AskParseError(`Internal validation failed for that query: ${problems.join("; ")}`);
  }

  return {
    query,
    targets: applied,
    models,
    explanations,
    notes: [...new Set(notes)],
    summary: explanations.join(" · "),
  };
}
