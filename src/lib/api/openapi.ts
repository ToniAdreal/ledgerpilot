/**
 * OpenAPI document — the machine-readable map of LedgerPilot's HTTP API.
 *
 * The app ships 29 API routes (31 operations) but, until this module,
 * the only map of them was prose: route-header comments and the
 * README's architecture list. A tool-calling client, a judge's API
 * explorer, or a generated client needs the same information in a
 * form software can consume — this module is that form (OpenAPI 3.1).
 *
 * Discipline:
 *  - **Completeness is test-enforced, not remembered.** The test suite
 *    walks `src/app/api/**\/route.ts` on disk, reads each file's
 *    exported HTTP methods, and requires the document to describe
 *    exactly those operations — a route added without a document
 *    entry (or an entry left behind for a deleted route) fails the
 *    suite. This module is therefore a registry first: one entry per
 *    operation, and the document is built from the registry.
 *  - **No invented URL.** `servers` carries a single relative entry
 *    (`url: "/"`) — the same no-invented-URL rule the layout,
 *    manifest, and robots follow before a public host exists. The
 *    document resolves against whatever origin serves it.
 *  - **No authentication is claimed or invented.** LedgerPilot's API
 *    has no auth layer; the approval gate is an application-level
 *    invariant (no plan executes without an approval decision), not
 *    authentication. Every operation therefore declares
 *    `security: []`, and the info description says plainly that a
 *    publicly exposed instance needs the deployer's own access
 *    controls (the warning SECURITY.md already carries for Judge
 *    Mode's demo controls).
 *  - **Errors share one shape.** Every error response in the app is
 *    `{ error: string }`; the document models it once as the `Error`
 *    component schema and references it from every non-2xx response.
 *  - **Runtime-backed operations share one 503.** Every operation
 *    except the three that never build the agent runtime
 *    (`getHealth`, `getOpenApiDocument`, `listAgentTools`) answers
 *    503 with that same error shape when sandbox mode is selected
 *    without credentials — the translation `src/lib/api/errors.ts`
 *    applies at the route boundary. The response is appended by
 *    `apiOperationResponses` below rather than repeated in each
 *    registry entry, so the registry and the routes cannot drift.
 *  - **Every operation shares one 405.** A documented path called
 *    with a method it does not support is answered by middleware
 *    (`src/lib/api/method-not-allowed.ts`, resolving allowed methods
 *    from this same registry) with a JSON 405 in the shared error
 *    shape and an `Allow` header. That response is appended by
 *    `apiOperationResponses` too, for every operation — method
 *    support is a property of the path, and the three non-runtime
 *    operations are not exempt (POST to the health route is a 405,
 *    not a readiness report).
 *  - **Body-bearing operations share one 413.** Every operation
 *    that takes a JSON request body (`requestBody: true`) answers
 *    413 with that same error shape when the body exceeds the
 *    shared size limit (`MAX_JSON_BODY_BYTES`, enforced in
 *    `src/lib/api/body.ts` before parsing, so an oversized body is
 *    rejected for its size whether or not it is well-formed). That
 *    response is appended by `apiOperationResponses` too, for
 *    body-bearing operations only — a GET has no body to refuse.
 */

export type ApiTag = "Agent" | "Console" | "Health" | "Judge Mode" | "PayPal";

export interface ApiOperation {
  path: string;
  method: "get" | "post";
  operationId: string;
  tag: ApiTag;
  summary: string;
  description: string;
  /** Status code → response description, in response order. */
  responses: Record<string, string>;
  /** True when the operation requires a JSON request body. */
  requestBody?: boolean;
  /** True when the JSON body must carry `id` + `event_type` (webhooks). */
  webhookEventBody?: boolean;
}

const GATE =
  "The plan is stored as pending_approval; no PayPal call happens until it is approved and executed through the ordinary agent flow — the approval gate has no back door on this surface.";

export const API_OPERATIONS: ApiOperation[] = [
  // ── Agent ──────────────────────────────────────────────────────────
  {
    path: "/api/agent/plan",
    method: "post",
    operationId: "createAgentPlan",
    tag: "Agent",
    summary: "Draft a typed action plan from a plain-English brief",
    description:
      "The deterministic parser compiles the brief into a typed action plan (the optional LLM adapter is consulted only on a parser miss, and only when configured). " +
      GATE,
    responses: {
      "201": "The drafted plan (pending_approval).",
      "400": "Malformed JSON or a missing brief.",
      "422": "The brief names no money action the parser can read.",
    },
    requestBody: true,
  },
  {
    path: "/api/agent/plan",
    method: "get",
    operationId: "listAgentPlans",
    tag: "Agent",
    summary: "List drafted plans and the activity log",
    description:
      "Returns every plan in the ledger (including the pending-decision queue the console renders) together with the append-only activity / audit records.",
    responses: { "200": "Plans and activity records." },
  },
  {
    path: "/api/agent/approve",
    method: "post",
    operationId: "decideAgentPlan",
    tag: "Agent",
    summary: "Approve or reject a pending plan",
    description:
      "The approval gate itself: records an approve or reject decision for a plan in pending_approval. Only an approved plan can be executed; a decision for a plan in any other state is a conflict.",
    responses: {
      "200": "The plan with its recorded decision.",
      "400": "Malformed JSON or a body that is not { planId, decision }.",
      "409": "The plan is not awaiting a decision.",
    },
    requestBody: true,
  },
  {
    path: "/api/agent/execute",
    method: "post",
    operationId: "executeAgentPlan",
    tag: "Agent",
    summary: "Execute an approved plan",
    description:
      "Runs an approved plan step by step through the PayPal adapter, writing an activity record around every call. Trigger-gated steps are deferred (the plan settles to awaiting_trigger) and resume only via a verified webhook or the sync reconciler — never via a second execute call.",
    responses: {
      "200": "The execution outcome, including any deferred steps.",
      "400": "Malformed JSON or a missing planId.",
      "409": "The plan is not approved (unapproved, rejected, or already settled).",
    },
    requestBody: true,
  },
  {
    path: "/api/agent/edit",
    method: "post",
    operationId: "editAgentPlanAmounts",
    tag: "Agent",
    summary: "Amend the amounts of a plan pending approval",
    description:
      "The plan-review Edit (amounts only): rewrites the amount/currency of a pending plan's money steps — a batch payout step per line — after validating every amount through the drafts module's money rules, regenerates the step descriptions approval will cover, and writes the amendment (old → new) to the audit log. Only a plan in pending_approval can be amended, so approval always covers exactly the steps the reviewer saw; recipients, work descriptions, due dates, and triggers are not editable here. Nothing executes on this surface.",
    responses: {
      "200": "The amended plan (still pending_approval).",
      "400": "Malformed JSON, an invalid amount, a step that carries no amount, or an edit that changes nothing.",
      "404": "Unknown plan.",
      "409": "The plan is not pending approval.",
    },
    requestBody: true,
  },
  {
    path: "/api/agent/suggest",
    method: "post",
    operationId: "suggestNextActions",
    tag: "Agent",
    summary: "Draft next-action reminder plans for overdue invoices",
    description:
      "The agent's next-action draft step (CONCEPT.md §3.1 data flow): scans for overdue open invoices — the read model's definition, most overdue first — and drafts one send_reminder plan (source: \"suggested\", pending_approval) per invoice that is not already covered, with the step identical to a hand-drafted reminder and its reference pinned to that invoice's number. An invoice whose reminder was already sent, or that a reminder plan in any status other than failed already targets (a rejected plan is not re-drafted), is reported under skipped instead. This surface only drafts: nothing is sent until a drafted plan is approved and executed through the ordinary gate. An optional referenceDate (yyyy-mm-dd) sets the date the overdue test is applied at; it defaults to today (UTC).",
    responses: {
      "200": "Reference date, overdue count, the drafted reminder plans, and the skipped invoices with their reasons.",
      "400": "Malformed JSON body or an invalid referenceDate.",
    },
    requestBody: true,
  },
  {
    path: "/api/agent/tools",
    method: "get",
    operationId: "listAgentTools",
    tag: "Agent",
    summary: "List the agent tool definitions",
    description:
      "Discovery surface for the MCP / Agent Toolkit-shaped action layer: the four typed actions as tool definitions ({ name, description, inputSchema } with closed schemas). Read-only.",
    responses: { "200": "The tool definitions." },
  },
  {
    path: "/api/agent/tools",
    method: "post",
    operationId: "draftPlanFromToolCalls",
    tag: "Agent",
    summary: "Draft a plan from one or more tool calls",
    description:
      "Accepts one call ({ name, arguments }) or a sequence ({ calls: [...] }, at most four). Calls are validated in code — unknown tools and undeclared arguments are rejected — and converted into a source: \"tool\" plan. " +
      GATE,
    responses: {
      "201": "The drafted plan (pending_approval).",
      "400": "Malformed JSON or any tool-call validation failure.",
    },
    requestBody: true,
  },
  // ── Console read models ────────────────────────────────────────────
  {
    path: "/api/console/summary",
    method: "get",
    operationId: "getConsoleSummary",
    tag: "Console",
    summary: "KPI totals for the operations console",
    description:
      "Per-currency totals (money is never summed across currencies), surface counts, pending approvals, and awaiting-trigger plans, projected from the adapter resources and the ledger.",
    responses: { "200": "The console summary." },
  },
  {
    path: "/api/console/invoices",
    method: "get",
    operationId: "listConsoleInvoices",
    tag: "Console",
    summary: "Invoice rows for the console grids",
    description:
      "Invoice read-model rows (recipient, amounts, collected portion, due date, overdue flag), newest first — the same projection the console home and the standalone /invoices page render.",
    responses: { "200": "Invoice rows." },
  },
  {
    path: "/api/console/invoices/{id}",
    method: "get",
    operationId: "getConsoleInvoice",
    tag: "Console",
    summary: "One invoice with its webhook-fed status timeline",
    description:
      "The invoice detail projection: the grid row plus line items, the chronological timeline of audit records that concern this invoice, and the plans related to it.",
    responses: {
      "200": "The invoice detail.",
      "404": "No invoice with that id exists in this instance.",
    },
  },
  {
    path: "/api/console/orders",
    method: "get",
    operationId: "listConsoleOrders",
    tag: "Console",
    summary: "Checkout order rows for the console grids",
    description:
      "Order read-model rows including capture state and the buyer-view resolution (payable orders carry their checkout link; mock links are flagged as mock).",
    responses: { "200": "Order rows." },
  },
  {
    path: "/api/console/payouts",
    method: "get",
    operationId: "listConsolePayouts",
    tag: "Console",
    summary: "Payout rows for the console grids",
    description:
      "Payout batches flattened to one row per payout item, with the batch id, batch status, and creation time carried into every row.",
    responses: { "200": "Payout rows (one per item)." },
  },
  {
    path: "/api/console/disputes",
    method: "get",
    operationId: "listConsoleDisputes",
    tag: "Console",
    summary: "Dispute rows (read-only)",
    description:
      "Dispute read-model rows with response deadlines and overdue flags. Seeded demo disputes are always flagged sample: true. The Disputes integration is read-only end to end.",
    responses: { "200": "Dispute rows." },
  },
  {
    path: "/api/console/disputes/{id}/evidence",
    method: "get",
    operationId: "getDisputeEvidence",
    tag: "Console",
    summary: "Draft-only evidence summary for one dispute",
    description:
      "A deterministic evidence summary assembled from the dispute record, Transaction Search, and the seller's invoices: verified facts, an evidence checklist, gaps, and a plain-text draft response. Draft only — nothing is ever submitted to PayPal from this surface.",
    responses: {
      "200": "The evidence summary draft.",
      "404": "No dispute with that id exists in this instance.",
    },
  },
  {
    path: "/api/console/transactions",
    method: "get",
    operationId: "listConsoleTransactions",
    tag: "Console",
    summary: "Reconciliation ledger rows (read-only)",
    description:
      "Transaction Search read-model rows with signed amounts (payments in positive, payouts out negative) — the ledger the KPI totals reconcile against.",
    responses: { "200": "Transaction rows, newest first." },
  },
  {
    path: "/api/console/activity",
    method: "get",
    operationId: "listConsoleActivity",
    tag: "Console",
    summary: "Agent activity and webhook audit rows",
    description:
      "The audit trail, newest first: every plan, approval, PayPal call, and webhook event, with webhook event ids surfaced for traceability.",
    responses: { "200": "Activity rows, newest first." },
  },
  // ── Health ─────────────────────────────────────────────────────────
  {
    path: "/api/health",
    method: "get",
    operationId: "getHealth",
    tag: "Health",
    summary: "Deployment readiness report",
    description:
      "An env-only readiness report (ok / degraded / misconfigured) that never constructs the runtime: it diagnoses exactly the case where the runtime cannot be built. It reports booleans and the names of missing variables only — never a secret value.",
    responses: {
      "200": "Readiness report with status ok or degraded.",
      "503": "Readiness report with status misconfigured, naming the missing environment variables.",
    },
  },
  // ── Judge Mode ─────────────────────────────────────────────────────
  {
    path: "/api/judge",
    method: "get",
    operationId: "getJudgeScenario",
    tag: "Judge Mode",
    summary: "Judge Mode scenario and live spine state",
    description:
      "The seeded-scenario descriptor (what will be loaded, the judge script, expected outcomes) plus the live state of the demo-spine plan and invoice.",
    responses: { "200": "Scenario descriptor and live state." },
  },
  {
    path: "/api/judge/seed",
    method: "post",
    operationId: "seedJudgeScenario",
    tag: "Judge Mode",
    summary: "Seed the Judge Mode demo scenario",
    description:
      "Loads the fictional demo history and leaves the demo-spine plan in pending_approval so the approval gate is experienced for real. Idempotent: seeding an already-seeded instance changes nothing and returns alreadySeeded: true. Demo control for a disposable mock-mode instance.",
    responses: { "200": "Seed result and the live judge state." },
  },
  {
    path: "/api/judge/pay",
    method: "post",
    operationId: "simulateJudgePayment",
    tag: "Judge Mode",
    summary: "Simulate payment of the spine invoice",
    description:
      "The documented local-run payment leg: a mock-mode record-payment for the spine invoice's full outstanding amount, after which the sync reconciler processes the resulting INVOICING.INVOICE.PAID event — the same code path a webhook delivery takes. Demo control for a disposable mock-mode instance.",
    responses: {
      "200": "The payment outcome (or an alreadyPaid no-op).",
      "409": "Not seeded yet, or the spine plan has not been executed.",
    },
  },
  {
    path: "/api/judge/reset",
    method: "post",
    operationId: "resetJudgeDemo",
    tag: "Judge Mode",
    summary: "Reset the demo to a fresh slate",
    description:
      "Clears plans, activity, processed event ids, and all mock resources, and restores the flagged sample dispute; id sequences never rewind. Mock mode only — in sandbox mode the resources live at PayPal and the reset refuses, before touching anything. Demo control for a disposable mock-mode instance.",
    responses: {
      "200": "Cleared counts and the fresh, unseeded state.",
      "409": "Reset refused (sandbox mode, or an adapter without reset support).",
    },
  },
  // ── PayPal ─────────────────────────────────────────────────────────
  {
    path: "/api/paypal/invoices",
    method: "post",
    operationId: "draftInvoice",
    tag: "PayPal",
    summary: "Draft an invoice plan (validated wrapper over Invoicing v2)",
    description:
      "Validates the invoice fields and drafts a single-step plan whose step is identical to the NL parser's invoice step. " +
      GATE,
    responses: {
      "201": "The drafted plan (pending_approval).",
      "400": "Malformed JSON or any field validation failure, naming the field.",
    },
    requestBody: true,
  },
  {
    path: "/api/paypal/invoices/record-payment",
    method: "post",
    operationId: "recordInvoicePayment",
    tag: "PayPal",
    summary: "Record a payment against an open invoice",
    description:
      "Records money that arrived outside PayPal against any open invoice — the full amount due by default, or an explicit partial amount (validated before any call: positive, the invoice's currency, never more than the amount due). A full payment processes the INVOICING.INVOICE.PAID event through the sync reconciler, so a trigger-gated payout bound to the invoice fires. Recording a payment is not an agent action and needs no plan approval: the gate governs committing the seller's money, not receiving it.",
    responses: {
      "200": "The recorded invoice and the reconciler result (or an alreadyPaid no-op).",
      "400": "Malformed JSON or a missing invoiceId.",
      "404": "No invoice with that id exists in this instance.",
      "409": "The invoice is not open (draft, cancelled, or refunded).",
      "422": "Invalid amount, or the adapter refused the recording.",
    },
    requestBody: true,
  },
  {
    path: "/api/paypal/orders",
    method: "post",
    operationId: "draftOrder",
    tag: "PayPal",
    summary: "Draft a checkout-order plan (validated wrapper over Orders v2)",
    description:
      "Validates the sale fields and drafts a single-step create_order plan. " + GATE,
    responses: {
      "201": "The drafted plan (pending_approval).",
      "400": "Malformed JSON or any field validation failure, naming the field.",
    },
    requestBody: true,
  },
  {
    path: "/api/paypal/orders/capture",
    method: "post",
    operationId: "captureOrder",
    tag: "PayPal",
    summary: "Capture a created checkout order",
    description:
      "The buyer-side completion leg: captures an order the buyer approved at checkout, audit-logs the exact call, and processes the PAYMENT.CAPTURE.COMPLETED event through the sync reconciler. Capturing is not an agent action and needs no plan approval (receiving money was never gated); in sandbox mode PayPal itself enforces the buyer-approval side. Re-capturing a completed order is an alreadyCaptured no-op.",
    responses: {
      "200": "The capture summary and the reconciler result.",
      "400": "Malformed JSON or a missing orderId.",
      "404": "No order with that id exists in this instance.",
      "409": "The order is voided and can never be captured.",
      "422": "The adapter refused the capture (for example, the buyer has not approved the order yet).",
    },
    requestBody: true,
  },
  {
    path: "/api/paypal/payouts",
    method: "post",
    operationId: "draftPayout",
    tag: "PayPal",
    summary: "Draft a payout plan (validated wrapper over Payouts)",
    description:
      "Validates a single payout or a batch of 1–25 lines (per-line validation, errors naming the line) and drafts one plan; a batch executes as exactly one Payouts batch. A draft may carry payWhenInvoicePaid to gate itself on one named invoice's payment event. " +
      GATE,
    responses: {
      "201": "The drafted plan (pending_approval).",
      "400": "Malformed JSON or any field validation failure, naming the field or line.",
    },
    requestBody: true,
  },
  {
    path: "/api/paypal/reminders",
    method: "post",
    operationId: "draftReminder",
    tag: "PayPal",
    summary: "Draft a payment-reminder plan (Invoicing v2 remind)",
    description:
      "Validates the recipient and optional invoice reference and drafts a send_reminder plan identical to the parser's reminder step; at execution the target resolves deterministically (the named invoice, or the recipient's most overdue open invoice). " +
      GATE,
    responses: {
      "201": "The drafted plan (pending_approval).",
      "400": "Malformed JSON or any field validation failure, naming the field.",
    },
    requestBody: true,
  },
  {
    path: "/api/paypal/webhooks",
    method: "post",
    operationId: "receivePayPalWebhook",
    tag: "PayPal",
    summary: "PayPal webhook listener",
    description:
      "Receives PayPal webhook events. The signature is verified through the adapter before the payload is trusted; verified events are processed exactly once by event id (a redelivery is acknowledged as a duplicate, which stops PayPal's retry loop) and resume any trigger-gated plan bound to the event's resource.",
    responses: {
      "200": "Event processed, or acknowledged as a duplicate.",
      "400": "Malformed JSON, or an event without id and event_type.",
      "401": "Signature verification failed; the event was not trusted or processed.",
    },
    requestBody: true,
    webhookEventBody: true,
  },
  {
    path: "/api/paypal/sync",
    method: "get",
    operationId: "syncFromPayPal",
    tag: "PayPal",
    summary: "Run the polling sync reconciler",
    description:
      "The webhook fallback for instances webhooks cannot reach: drains undelivered adapter events in order and sweeps resource state, resuming trigger-gated plans. Idempotent — repeat calls are no-ops — and it never calls a mutating PayPal endpoint.",
    responses: { "200": "Checked counts, processed and already-processed event ids, resumed plans, and current resource states." },
  },
  // ── This document ──────────────────────────────────────────────────
  {
    path: "/api/openapi",
    method: "get",
    operationId: "getOpenApiDocument",
    tag: "Health",
    summary: "This OpenAPI document",
    description:
      "The machine-readable map of every operation in this API, built from the same registry the test suite checks against the route files on disk. Read-only; carries no host URL and no credentials.",
    responses: { "200": "The OpenAPI 3.1 document." },
  },
];

/**
 * Operations that never build the agent runtime, and therefore can
 * never answer the runtime-backed 503: the health report is env-only
 * by design (it diagnoses exactly this failure), the OpenAPI document
 * is built from this registry, and the tool definitions' GET is a
 * static list. Every other registered operation is runtime-backed.
 */
export const NON_RUNTIME_OPERATION_IDS: ReadonlySet<string> = new Set([
  "getHealth",
  "getOpenApiDocument",
  "listAgentTools",
]);

export const RUNTIME_NOT_CONFIGURED_RESPONSE =
  "Sandbox mode is selected but PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set, so the agent runtime cannot be built; the error names the missing variables (see GET /api/health).";

export const METHOD_NOT_ALLOWED_RESPONSE =
  "The path is documented but does not support this method; the API answers a JSON { error } naming the allowed methods, with an Allow header (middleware resolves the allowed methods from this same registry).";

export const REQUEST_BODY_TOO_LARGE_RESPONSE =
  "The JSON request body exceeds the shared 131072-byte (128 KiB) limit; the API answers a JSON { error } naming the limit before parsing, so no validator or PayPal call is reached. Every legitimate body is far smaller — the largest, a maximum-size payout batch draft, is roughly 27 KB.";

/**
 * The responses an operation can actually return: its registry
 * responses, plus the shared 405 every documented path answers a
 * wrong-method call with, plus the shared runtime-backed 503 for
 * every operation that builds the agent runtime, plus the shared
 * 413 for every operation that takes a JSON request body. Used by
 * both the OpenAPI builder and the human-readable /api-docs page,
 * so the two surfaces agree.
 */
export function apiOperationResponses(op: ApiOperation): Record<string, string> {
  let responses = op.responses;
  if (!("405" in responses)) {
    responses = { ...responses, "405": METHOD_NOT_ALLOWED_RESPONSE };
  }
  if (op.requestBody && !("413" in responses)) {
    responses = { ...responses, "413": REQUEST_BODY_TOO_LARGE_RESPONSE };
  }
  if (!NON_RUNTIME_OPERATION_IDS.has(op.operationId) && !("503" in responses)) {
    responses = { ...responses, "503": RUNTIME_NOT_CONFIGURED_RESPONSE };
  }
  return responses;
}

export const API_TAGS: Array<{ name: ApiTag; description: string }> = [
  { name: "Agent", description: "Brief → plan → approval → execution, and the tool-call-shaped action layer." },
  { name: "Console", description: "Read models feeding the operations console grids and detail pages." },
  { name: "Health", description: "Deployment readiness and this API document." },
  { name: "Judge Mode", description: "The seeded demo scenario for a disposable mock-mode instance." },
  { name: "PayPal", description: "Validated plan-draft wrappers, the webhook listener, capture, record-payment, and the sync reconciler." },
];

function operationObject(op: ApiOperation): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const [code, description] of Object.entries(apiOperationResponses(op))) {
    const isError = !code.startsWith("2");
    responses[code] = {
      description,
      content: {
        "application/json": {
          schema: isError
            ? { $ref: "#/components/schemas/Error" }
            : { type: "object" },
        },
      },
    };
  }
  const operation: Record<string, unknown> = {
    operationId: op.operationId,
    tags: [op.tag],
    summary: op.summary,
    description: op.description,
    security: [],
    responses,
  };
  if (op.path.includes("{id}")) {
    operation.parameters = [
      {
        name: "id",
        in: "path",
        required: true,
        description: "The resource id in this instance (for example an invoice or dispute id).",
        schema: { type: "string" },
      },
    ];
  }
  if (op.requestBody) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: op.webhookEventBody
            ? {
                type: "object",
                required: ["id", "event_type"],
                properties: {
                  id: { type: "string", description: "The webhook event id (idempotency key)." },
                  event_type: { type: "string", description: "The PayPal event type." },
                  resource: { type: "object", description: "The event's resource payload." },
                },
              }
            : { type: "object" },
        },
      },
    };
  }
  return operation;
}

/** Build the OpenAPI 3.1 document from the operation registry (fresh deep copy per call). */
export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of API_OPERATIONS) {
    paths[op.path] = { ...(paths[op.path] ?? {}), [op.method]: operationObject(op) };
  }
  const document = {
    openapi: "3.1.0",
    info: {
      title: "LedgerPilot API",
      version: "0.1.0",
      description:
        "LedgerPilot is an approval-gated AI money operator built on PayPal (sandbox / mock only — no real money moves anywhere in this project). " +
        "This API has no authentication layer: the approval gate is an application-level invariant, not authentication, and Judge Mode's seed / pay / reset operations are demo controls for a disposable mock-mode instance. " +
        "Do not expose a sandbox-mode instance publicly without your own access controls.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: "/", description: "Same origin as the serving instance (relative — no host is declared)." }],
    tags: API_TAGS,
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          additionalProperties: false,
          properties: {
            error: { type: "string", description: "A human-readable reason, safe to show an operator." },
          },
        },
      },
    },
  };
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
}
