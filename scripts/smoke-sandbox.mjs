#!/usr/bin/env node
/**
 * LedgerPilot sandbox verification smoke — the Oct 24 exit test
 * (CONCEPT.md §3.4: the invoice leg runs end-to-end in sandbox once
 * the account exists), automated the same way scripts/smoke.mjs
 * automated the mock-mode Judge Mode loop.
 *
 * Drives a running SANDBOX-mode instance over its own HTTP API —
 * health, invoice draft → approve → execute → record-payment,
 * payout draft → approve → execute, order draft → approve →
 * execute → buyer-link check, sync — so the live-sandbox flows are
 * exercised through exactly the surfaces a judge would use, with
 * the approval gate passed through, never shortcut.
 *
 * Safety rules:
 *   - SANDBOX MODE ONLY, and it proves it before touching anything:
 *     the first step reads GET /api/health (which is env-only and
 *     answers even when the runtime cannot be built). A mock-mode
 *     target is refused, and a misconfigured sandbox (missing
 *     PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET — health answers 503
 *     and names the variables) stops the run at that step. Nothing
 *     is drafted, approved, or executed before the mode check.
 *   - This script reads NO credentials and sends none. Credentials
 *     live in the target instance's own environment (its own PayPal
 *     Developer sandbox app); the only environment variable this
 *     script consults is SMOKE_BASE_URL. All money here is sandbox
 *     money: the amounts are fictional verification amounts
 *     (USD 10.00 invoice, USD 2.00 payout, USD 5.00 order) and the
 *     counterparty is the fictional "Sandbox Check" contact.
 *   - NOT re-runnable-clean by design: unlike the mock smoke there
 *     is no reset (reset refuses sandbox mode — resources live at
 *     PayPal). Each run creates fresh sandbox resources; ids are
 *     printed so the run can be found in the sandbox dashboard.
 *   - The order is created and its buyer checkout link verified,
 *     but capture is deliberately NOT attempted: in sandbox mode a
 *     capture requires the buyer to approve on PayPal's hosted
 *     checkout first, which is a browser step, not a smoke step.
 *   - Payout acceptance: sandbox payouts to a recipient who is not
 *     a sandbox account come back UNCLAIMED (or PENDING) — PayPal
 *     accepted the batch, which is what this leg verifies (plus
 *     that the batch is visible in the console read model). An
 *     execute-time refusal (e.g. Payouts not enabled on the sandbox
 *     Business account — the CONCEPT.md §3.7 risk) fails the step
 *     with PayPal's error verbatim.
 *
 * Usage:
 *   npm run smoke:sandbox                            # http://127.0.0.1:3000
 *   npm run smoke:sandbox -- --base-url http://127.0.0.1:3100
 *   SMOKE_BASE_URL=http://127.0.0.1:3100 npm run smoke:sandbox
 *
 * Exit code 0 = every step passed; 1 = the named step failed, with
 * the expected and actual values printed. Node >= 22, no deps.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 30000;

/** Fictional sandbox-verification amounts (sandbox money only). */
const INVOICE_AMOUNT = "10.00";
const PAYOUT_AMOUNT = "2.00";
const ORDER_AMOUNT = "5.00";
const COUNTERPARTY = "Sandbox Check";
const ACCEPTED_PAYOUT_STATUSES = ["SUCCESS", "UNCLAIMED", "PENDING"];

class SmokeError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

function parseBaseUrl(argv, env) {
  let base = env.SMOKE_BASE_URL || DEFAULT_BASE_URL;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url" && argv[i + 1]) {
      base = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--base-url=")) {
      base = arg.slice("--base-url=".length);
    } else if (/^https?:\/\//.test(arg)) {
      base = arg;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run smoke:sandbox [-- --base-url <url>]  (or set SMOKE_BASE_URL)");
      process.exit(0);
    }
  }
  return base.replace(/\/+$/, "");
}

async function request(baseUrl, method, path, body) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SmokeError(
      path,
      `request to ${method} ${path} did not complete: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new SmokeError(path, `${method} ${path} returned non-JSON (HTTP ${response.status})`);
  }
  return { status: response.status, json };
}

function expectStatus(step, actual, expected) {
  if (actual !== expected) {
    throw new SmokeError(step, `expected HTTP ${expected}, got HTTP ${actual}`);
  }
}

function expectEqual(step, label, actual, expected) {
  if (actual !== expected) {
    throw new SmokeError(
      step,
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function serverError(json) {
  return typeof json?.error === "string" ? json.error : JSON.stringify(json ?? {});
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

/** Draft a plan through a /api/paypal/* wrapper and pass it through the gate. */
async function draftApproveExecute(baseUrl, kind, draftPath, draftBody) {
  const draftStep = `${kind} draft`;
  const draft = await request(baseUrl, "POST", draftPath, draftBody);
  expectStatus(draftStep, draft.status, 201);
  const plan = draft.json?.plan;
  if (!plan?.id) {
    throw new SmokeError(draftStep, "draft response carries no plan");
  }
  expectEqual(draftStep, "drafted plan status", plan.status, "pending_approval");

  const approveStep = `${kind} approve`;
  const approve = await request(baseUrl, "POST", "/api/agent/approve", {
    planId: plan.id,
    decision: "approve",
  });
  expectStatus(approveStep, approve.status, 200);
  expectEqual(approveStep, "plan status after approval", approve.json?.plan?.status, "approved");

  const executeStep = `${kind} execute`;
  const execute = await request(baseUrl, "POST", "/api/agent/execute", { planId: plan.id });
  if (execute.status !== 200) {
    throw new SmokeError(
      executeStep,
      `expected HTTP 200, got HTTP ${execute.status}: ${serverError(execute.json)}`,
    );
  }
  const outcomes = execute.json?.outcomes ?? [];
  const executed = outcomes.find((o) => o.outcome === "executed");
  if (!executed?.resultId) {
    const firstError = outcomes.find((o) => o.error)?.error;
    throw new SmokeError(
      executeStep,
      `no executed outcome with a result id (outcomes: ${JSON.stringify(outcomes)})` +
        (firstError ? `; step error: ${firstError}` : ""),
    );
  }
  return { planId: plan.id, resultId: executed.resultId };
}

async function main() {
  const baseUrl = parseBaseUrl(process.argv.slice(2), process.env);
  console.log(`LedgerPilot sandbox verification against ${baseUrl} (sandbox-mode instances only)`);

  // 1. Readiness + mode gate: sandbox, configured — before anything
  //    is drafted. Health is env-only, so it can diagnose the exact
  //    instance states this step exists to refuse.
  const healthStep = "health";
  const health = await request(baseUrl, "GET", "/api/health");
  if (health.status === 503 || health.json?.health?.status === "misconfigured") {
    const failing = (health.json?.health?.checks ?? [])
      .filter((c) => c.status === "fail")
      .map((c) => c.detail)
      .join(" ");
    throw new SmokeError(
      healthStep,
      `instance is misconfigured (health status "misconfigured"): ${failing || "see GET /api/health"}`,
    );
  }
  expectStatus(healthStep, health.status, 200);
  const mode = health.json?.health?.config?.paypalMode;
  if (mode !== "sandbox") {
    throw new SmokeError(
      healthStep,
      `refusing to run: target is in ${JSON.stringify(mode ?? "unknown")} mode, not sandbox — ` +
        "this smoke creates real sandbox resources and proves nothing against the mock adapter; use `npm run smoke` for mock mode",
    );
  }
  if (health.json?.health?.status === "degraded") {
    console.log(
      "note - health is degraded (sandbox webhook id unset): webhook deliveries cannot be verified on this instance; the sync reconciler step below is the fallback this run exercises",
    );
  }
  ok("health: sandbox mode, credentials configured");

  // 2. Invoice leg (the CONCEPT.md §3.4 exit test): draft through
  //    the gate, execute (create + send via Invoicing v2), verify
  //    the console read model shows it SENT.
  const { resultId: invoiceId } = await draftApproveExecute(
    baseUrl,
    "invoice",
    "/api/paypal/invoices",
    {
      recipientName: COUNTERPARTY,
      description: "Sandbox verification invoice",
      amount: INVOICE_AMOUNT,
      currency: "USD",
    },
  );
  const invoiceRowsStep = "invoice verify";
  const invoiceRows = await request(baseUrl, "GET", "/api/console/invoices");
  expectStatus(invoiceRowsStep, invoiceRows.status, 200);
  const invoiceRow = (invoiceRows.json?.invoices ?? []).find((r) => r.id === invoiceId);
  if (!invoiceRow) {
    throw new SmokeError(invoiceRowsStep, `invoice ${invoiceId} not present in GET /api/console/invoices`);
  }
  expectEqual(invoiceRowsStep, "invoice status", invoiceRow.status, "SENT");
  expectEqual(invoiceRowsStep, "invoice amount", invoiceRow.amount, INVOICE_AMOUNT);
  ok(`invoice ${invoiceId} created and SENT (USD ${INVOICE_AMOUNT})`);

  // 3. Payment leg: record the payment (Invoicing record-payment —
  //    the documented local/sandbox path); the route runs the sync
  //    reconciler, so the PAID state is the reconciled state.
  const payStep = "record payment";
  const pay = await request(baseUrl, "POST", "/api/paypal/invoices/record-payment", {
    invoiceId,
  });
  if (pay.status !== 200) {
    throw new SmokeError(payStep, `expected HTTP 200, got HTTP ${pay.status}: ${serverError(pay.json)}`);
  }
  expectEqual(payStep, "alreadyPaid on first payment", pay.json?.alreadyPaid, false);
  // PayPal marks an externally recorded payment MARKED_AS_PAID;
  // PAID is reserved for payments captured through PayPal itself
  // (verified live in sandbox 2026-10-16). Both are settled states
  // in the app's model (record-payment.ts treats them alike).
  const settledStatus = pay.json?.invoice?.status;
  if (settledStatus !== "PAID" && settledStatus !== "MARKED_AS_PAID") {
    throw new SmokeError(payStep, `invoice status after payment: expected a settled state (PAID or MARKED_AS_PAID), got ${JSON.stringify(settledStatus)}`);
  }
  ok(`invoice ${invoiceId} recorded paid (${settledStatus})`);

  // 4. Payout leg: draft through the gate and execute one batch.
  //    Acceptance is PayPal-side (see header): the batch must exist
  //    in the console read model with an accepted item status. A
  //    refusal here is the payouts-enablement risk surfacing.
  const { resultId: batchId } = await draftApproveExecute(
    baseUrl,
    "payout",
    "/api/paypal/payouts",
    {
      recipientName: COUNTERPARTY,
      amount: PAYOUT_AMOUNT,
      currency: "USD",
      note: "Sandbox verification payout",
    },
  );
  const payoutRowsStep = "payout verify";
  const payoutRows = await request(baseUrl, "GET", "/api/console/payouts");
  expectStatus(payoutRowsStep, payoutRows.status, 200);
  const payoutRow = (payoutRows.json?.payouts ?? []).find((r) => r.batchId === batchId);
  if (!payoutRow) {
    throw new SmokeError(payoutRowsStep, `payout batch ${batchId} not present in GET /api/console/payouts`);
  }
  if (!ACCEPTED_PAYOUT_STATUSES.includes(payoutRow.status)) {
    throw new SmokeError(
      payoutRowsStep,
      `payout item status: expected one of ${ACCEPTED_PAYOUT_STATUSES.join("/")}, got ${JSON.stringify(payoutRow.status)}`,
    );
  }
  ok(`payout batch ${batchId} accepted (item status ${payoutRow.status}, USD ${PAYOUT_AMOUNT})`);

  // 5. Order leg: create an Orders v2 order through the gate and
  //    verify the buyer checkout link is a real PayPal URL. Capture
  //    is not attempted (buyer approval is a browser step — header).
  const { resultId: orderId } = await draftApproveExecute(baseUrl, "order", "/api/paypal/orders", {
    description: "Sandbox verification order",
    amount: ORDER_AMOUNT,
    currency: "USD",
  });
  const orderRowsStep = "order verify";
  const orderRows = await request(baseUrl, "GET", "/api/console/orders");
  expectStatus(orderRowsStep, orderRows.status, 200);
  const orderRow = (orderRows.json?.orders ?? []).find((r) => r.id === orderId);
  if (!orderRow) {
    throw new SmokeError(orderRowsStep, `order ${orderId} not present in GET /api/console/orders`);
  }
  expectEqual(orderRowsStep, "order checkout state", orderRow.checkoutState, "payable");
  if (typeof orderRow.checkoutUrl !== "string" || !orderRow.checkoutUrl.startsWith("https://")) {
    throw new SmokeError(
      orderRowsStep,
      `buyer checkout link: expected a real https:// PayPal URL, got ${JSON.stringify(orderRow.checkoutUrl)}`,
    );
  }
  console.log(
    "note - order capture not attempted: sandbox capture requires the buyer to approve at the checkout link first (browser step)",
  );
  ok(`order ${orderId} CREATED with a live buyer checkout link (USD ${ORDER_AMOUNT})`);

  // 6. Sync reconciler: the webhook fallback path answers and is
  //    idempotent-safe to call after the flows above.
  const syncStep = "sync";
  const sync = await request(baseUrl, "GET", "/api/paypal/sync");
  expectStatus(syncStep, sync.status, 200);
  if (!sync.json?.checked || typeof sync.json.checked !== "object") {
    throw new SmokeError(syncStep, "sync response carries no checked counts");
  }
  ok(`sync reconciler answered (checked ${JSON.stringify(sync.json.checked)})`);

  console.log(`SANDBOX SMOKE OK — live sandbox flows verified end to end at ${baseUrl}`);
}

main().catch((err) => {
  if (err instanceof SmokeError) {
    console.error(`SANDBOX SMOKE FAILED at step "${err.step}": ${err.message}`);
  } else {
    console.error(`SANDBOX SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
