#!/usr/bin/env node
/**
 * LedgerPilot publish-day smoke check.
 *
 * Drives one complete Judge Mode loop over HTTP against a running
 * instance — health, reset, seed, approve, execute, pay, summary —
 * and asserts the exact end state the README promises for the demo
 * spine (the seeded history plus Ana's USD 450 invoice paid and the
 * gated USD 200 payout to Marco released). Until now that loop was
 * verified by hand with a fresh set of curl commands on every build
 * round; this script is that checklist, automated.
 *
 * Safety rules:
 *   - MOCK MODE ONLY. The script resets the target instance first so
 *     it is re-runnable, and reset is a demo control: only ever point
 *     this at a disposable mock-mode demo instance, never at an
 *     instance holding data you care about, and never at sandbox
 *     mode (the reset step refuses there, and this script fails).
 *   - No credentials are read or sent. The only environment variable
 *     consulted is SMOKE_BASE_URL; no PayPal or LLM variable is
 *     touched, and the loop needs none — that is the point of the
 *     mock-first Judge Mode path.
 *
 * Usage:
 *   npm run smoke                            # http://127.0.0.1:3000
 *   npm run smoke -- --base-url http://127.0.0.1:3100
 *   SMOKE_BASE_URL=https://demo.example npm run smoke
 *
 * Exit code 0 = every step passed; 1 = the named step failed, with
 * the expected and actual values printed. Node >= 22, no deps.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 15000;

/** The README's expected post-loop totals (per currency, never summed). */
const EXPECTED_COLLECTED = { EUR: "100.00", USD: "570.00" };
const EXPECTED_OUTSTANDING = { EUR: "200.00", USD: "280.00" };
const EXPECTED_CAPTURED_ORDERS = { USD: "59.00" };
const EXPECTED_PAYOUTS_SENT = { USD: "280.00" };
const EXPECTED_COUNTS = {
  invoices: 4,
  orders: 1,
  payouts: 2,
  plans: 1,
  disputes: 1,
  transactions: 5,
};

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
      console.log("Usage: npm run smoke [-- --base-url <url>]  (or set SMOKE_BASE_URL)");
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

/** MoneyTotal[] -> { USD: "570.00" } for exact per-currency comparison. */
function totalsMap(totals) {
  const map = {};
  for (const total of totals ?? []) {
    map[total.currency_code] = total.value;
  }
  return map;
}

function expectTotals(step, label, totals, expected) {
  const actual = totalsMap(totals);
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const currency of keys) {
    if (actual[currency] !== expected[currency]) {
      throw new SmokeError(
        step,
        `${label} ${currency}: expected ${expected[currency] ?? "(absent)"}, got ${actual[currency] ?? "(absent)"}`,
      );
    }
  }
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function main() {
  const baseUrl = parseBaseUrl(process.argv.slice(2), process.env);
  console.log(`LedgerPilot smoke check against ${baseUrl} (mock-mode demo instances only)`);

  // 1. Readiness: the instance must report ok before any loop runs.
  const healthStep = "health";
  const health = await request(baseUrl, "GET", "/api/health");
  expectStatus(healthStep, health.status, 200);
  expectEqual(healthStep, "health status", health.json?.health?.status, "ok");
  ok("health reports ok");

  // 2. Reset first, so the script is re-runnable against an instance
  //    a previous judge (or a previous smoke run) already used. This
  //    is why the target must be a disposable mock-mode demo.
  const resetStep = "reset";
  const reset = await request(baseUrl, "POST", "/api/judge/reset");
  if (reset.status === 409) {
    throw new SmokeError(
      resetStep,
      "reset refused (409): the target is not a disposable mock-mode demo instance — refusing to continue",
    );
  }
  expectStatus(resetStep, reset.status, 200);
  expectEqual(resetStep, "state after reset is unseeded", reset.json?.state?.seeded, false);
  ok("demo reset to a fresh slate");

  // 3. Seed the Judge Mode scenario: history + the spine plan waiting
  //    at the approval gate.
  const seedStep = "seed";
  const seed = await request(baseUrl, "POST", "/api/judge/seed");
  expectStatus(seedStep, seed.status, 200);
  expectEqual(seedStep, "alreadySeeded after a reset", seed.json?.alreadySeeded, false);
  expectEqual(seedStep, "seeded", seed.json?.state?.seeded, true);
  expectEqual(seedStep, "seeded invoices", seed.json?.state?.counts?.invoices, 3);
  expectEqual(seedStep, "seeded orders", seed.json?.state?.counts?.orders, 1);
  expectEqual(seedStep, "seeded payouts", seed.json?.state?.counts?.payouts, 1);
  const plan = seed.json?.state?.spinePlan;
  if (!plan?.id) {
    throw new SmokeError(seedStep, "seed response carries no spine plan");
  }
  expectEqual(seedStep, "spine plan status", plan.status, "pending_approval");
  ok(`scenario seeded; spine plan ${plan.id} is pending_approval`);

  // 4. The approval gate: approve, and only then may anything execute.
  const approveStep = "approve";
  const approve = await request(baseUrl, "POST", "/api/agent/approve", {
    planId: plan.id,
    decision: "approve",
  });
  expectStatus(approveStep, approve.status, 200);
  expectEqual(approveStep, "plan status after approval", approve.json?.plan?.status, "approved");
  ok("plan approved through the gate");

  // 5. Execute: the invoice is created and SENT now; the payout stays
  //    gated on the payment event, so the plan awaits its trigger.
  const executeStep = "execute";
  const execute = await request(baseUrl, "POST", "/api/agent/execute", { planId: plan.id });
  expectStatus(executeStep, execute.status, 200);
  expectEqual(executeStep, "plan status after execute", execute.json?.plan?.status, "awaiting_trigger");
  ok("plan executed; payout deferred (awaiting_trigger)");

  // 6. The payment leg: mock record-payment + the sync reconciler
  //    resume the gated payout and close the plan.
  const payStep = "pay";
  const pay = await request(baseUrl, "POST", "/api/judge/pay");
  expectStatus(payStep, pay.status, 200);
  expectEqual(payStep, "alreadyPaid on first payment", pay.json?.alreadyPaid, false);
  expectEqual(payStep, "spine invoice status", pay.json?.invoice?.status, "PAID");
  expectEqual(payStep, "spine plan status after payment", pay.json?.spinePlanStatus, "completed");
  ok("invoice PAID; gated payout released; plan completed");

  // 7. The console summary must match the README's expected totals
  //    exactly — per currency, never summed across currencies.
  const summaryStep = "summary";
  const summaryResponse = await request(baseUrl, "GET", "/api/console/summary");
  expectStatus(summaryStep, summaryResponse.status, 200);
  const summary = summaryResponse.json?.summary;
  if (!summary) {
    throw new SmokeError(summaryStep, "summary response carries no summary");
  }
  expectTotals(summaryStep, "collected", summary.collected, EXPECTED_COLLECTED);
  expectTotals(summaryStep, "outstanding", summary.outstanding, EXPECTED_OUTSTANDING);
  expectTotals(summaryStep, "capturedOrders", summary.capturedOrders, EXPECTED_CAPTURED_ORDERS);
  expectTotals(summaryStep, "payoutsSent", summary.payoutsSent, EXPECTED_PAYOUTS_SENT);
  for (const [key, expected] of Object.entries(EXPECTED_COUNTS)) {
    expectEqual(summaryStep, `counts.${key}`, summary.counts?.[key], expected);
  }
  expectEqual(summaryStep, "pendingApprovals", summary.pendingApprovals, 0);
  expectEqual(summaryStep, "awaitingTrigger", summary.awaitingTrigger, 0);
  ok("console summary matches the README totals exactly");

  console.log(`SMOKE OK — Judge Mode loop verified end to end at ${baseUrl}`);
}

main().catch((err) => {
  if (err instanceof SmokeError) {
    console.error(`SMOKE FAILED at step "${err.step}": ${err.message}`);
  } else {
    console.error(`SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
