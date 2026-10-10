/**
 * Judge Mode — the one-click seeded demo scenario (CONCEPT.md §3.1/§3.6).
 *
 * A judge needs no PayPal account, no API keys, and no install to see the
 * full LedgerPilot loop. Seeding loads a small, fictional, deterministic
 * history into the mock adapter + ledger store:
 *
 *   - a PAID invoice (Ana, USD 120 — icon set),
 *   - a PARTIALLY_PAID, overdue invoice (Marco, EUR 300, EUR 100 paid),
 *   - an open SENT invoice (Sam Rivera, USD 280 — landing page copy),
 *   - a COMPLETED, captured checkout order (studio cable pack, USD 59),
 *   - a SUCCESS payout batch (Marco, USD 80 — hosting help),
 *   - the sample dispute the mock adapter already carries (flagged
 *     `sample: true`, never presented as live PayPal data),
 *   - and the demo-spine plan itself, left in `pending_approval`:
 *     "Invoice Ana $450 for brand work, due Friday. When it lands, pay
 *     $200 to my contractor Marco." — the judge approves and executes
 *     it themselves, so the approval gate is experienced, not narrated.
 *
 * Honesty rules baked in:
 *   - All names/amounts are the fictional CONCEPT.md demo data.
 *   - Historical webhook events are marked processed at seed time and
 *     listed in the seed audit record: they are history, so a later
 *     `GET /api/paypal/sync` must never replay the historical
 *     INVOICE.PAID event into the spine plan's gated payout. Only the
 *     spine invoice's own payment (a new event id) can resume it.
 *   - The payment leg is labeled what it is in mock mode: the
 *     Invoicing record-payment API (`simulateJudgeInvoicePayment`),
 *     the same path CONCEPT.md §3.2 documents for local runs — not a
 *     fake buyer checkout.
 *
 * Seeding is idempotent: a second call returns `alreadySeeded: true`
 * and changes nothing.
 */

import { parseBrief } from "../agent/parser";
import { syncFromPayPal, type SyncResult } from "../agent/reconciler";
import type { LedgerStore } from "../agent/store";
import type { PayPalClient } from "../paypal/client";
import type { ActionPlan, Invoice } from "../types";

/* ------------------------------------------------------------------ */
/* Scenario descriptor (static — the /judge page renders this)         */
/* ------------------------------------------------------------------ */

export const JUDGE_SEED_ID = "judge-demo-v1";

/** Fixed reference "now" for the seeded scenario: Saturday 2026-10-10 (UTC). */
export const JUDGE_REFERENCE_ISO = "2026-10-10T12:00:00.000Z";
export const JUDGE_REFERENCE_DATE = "2026-10-10";

/** The canonical demo-spine brief (CONCEPT.md §3.5 storyboard). */
export const JUDGE_BRIEF =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";

export interface JudgeScenarioStep {
  title: string;
  description: string;
  /** Who performs this step when the judge follows the script. */
  actor: "judge" | "agent" | "system";
}

export interface JudgeScenario {
  id: string;
  title: string;
  brief: string;
  referenceDate: string;
  /** What seeding puts in place, in plain language. */
  seededHistory: string[];
  /** The script the judge follows after seeding. */
  steps: JudgeScenarioStep[];
  /** What the console must show when the script has run end-to-end. */
  expectedOutcome: string[];
}

export function getJudgeScenario(): JudgeScenario {
  return {
    id: JUDGE_SEED_ID,
    title: "Judge Mode — the LedgerPilot demo spine, seeded",
    brief: JUDGE_BRIEF,
    referenceDate: JUDGE_REFERENCE_DATE,
    seededHistory: [
      "Invoice to Ana — USD 120.00 for an icon set — PAID (money already collected).",
      "Invoice to Marco — EUR 300.00 for consulting, EUR 100.00 paid — PARTIALLY_PAID and overdue (due 2026-10-01).",
      "Invoice to Sam Rivera — USD 280.00 for landing page copy — SENT, due 2026-10-20.",
      "Checkout order — studio cable pack, USD 59.00 — COMPLETED with a capture.",
      "Payout batch — USD 80.00 to Marco for hosting help — SUCCESS.",
      "One open dispute row, clearly flagged as sample data (sandbox disputes cannot be manufactured on demand).",
      "The demo-spine plan below, drafted by the deterministic agent and waiting for approval — nothing has executed.",
    ],
    steps: [
      {
        title: "Load the scenario",
        description: "Click “Load Judge Mode scenario”. The console fills with the seeded history above and one plan appears in pending approval.",
        actor: "judge",
      },
      {
        title: "Review the plan — the approval gate",
        description: `The plan for “${JUDGE_BRIEF}” lists two exact PayPal calls: create + send the invoice now, and a payout that is trigger-gated on INVOICING.INVOICE.PAID. Nothing runs until you approve it.`,
        actor: "judge",
      },
      {
        title: "Approve, then execute",
        description: "Approve the plan in the Operations Console (Agent Command bar → pending queue), then execute it. The USD 450.00 invoice to Ana is created and SENT; the USD 200.00 payout to Marco is deferred — the plan sits in awaiting_trigger.",
        actor: "judge",
      },
      {
        title: "Simulate the invoice payment (record-payment)",
        description: "Back here, click “Simulate invoice payment”. In mock mode this calls the Invoicing record-payment API for the full amount — the documented local-run substitute for the buyer paying on PayPal's hosted page — then runs the sync reconciler, which processes the INVOICING.INVOICE.PAID event exactly once.",
        actor: "judge",
      },
      {
        title: "Watch the loop close itself",
        description: "The verified payment event resumes the gated payout: USD 200.00 goes to Marco, the plan completes, and the console's four grids plus the audit trail show one unbroken trace — brief → plan → approval → PayPal calls → webhook → money out.",
        actor: "system",
      },
    ],
    expectedOutcome: [
      "Spine invoice INV2-* for USD 450.00 flips SENT → PAID (due Friday 2026-10-16 from the 2026-10-10 reference date).",
      "A second payout batch pays USD 200.00 to Marco with status SUCCESS.",
      "The spine plan ends in status completed; the audit grid contains plan, approval, paypal_call, webhook, and payout rows in order.",
      "Running sync again is a no-op — every event id is processed exactly once.",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Seed state                                                          */
/* ------------------------------------------------------------------ */

export class JudgeModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeModeError";
  }
}

export interface JudgeSeedRecord {
  spinePlanId: string;
  invoiceIds: string[];
  orderId: string;
  payoutBatchId: string;
  /** Historical emitted event ids marked processed during seeding. */
  preProcessedEventIds: string[];
}

/** The seed audit record is the marker: its detail carries the seed id + ids. */
function findSeedRecord(store: LedgerStore): JudgeSeedRecord | null {
  for (const rec of store.listActivity()) {
    if (rec.detail?.judgeSeed === JUDGE_SEED_ID) {
      return {
        spinePlanId: String(rec.detail.spinePlanId ?? ""),
        invoiceIds: Array.isArray(rec.detail.invoiceIds) ? rec.detail.invoiceIds.map(String) : [],
        orderId: String(rec.detail.orderId ?? ""),
        payoutBatchId: String(rec.detail.payoutBatchId ?? ""),
        preProcessedEventIds: Array.isArray(rec.detail.preProcessedEventIds)
          ? rec.detail.preProcessedEventIds.map(String)
          : [],
      };
    }
  }
  return null;
}

export function isJudgeSeeded(store: LedgerStore): boolean {
  return findSeedRecord(store) !== null;
}

export interface JudgeState {
  seeded: boolean;
  seed: JudgeSeedRecord | null;
  spinePlan: ActionPlan | null;
  /** The invoice created by executing the spine plan, once it exists. */
  spineInvoice: { id: string; status: Invoice["status"]; amount: string; currency_code: string } | null;
  counts: { invoices: number; orders: number; payouts: number; plans: number };
}

export async function getJudgeState(store: LedgerStore, client: PayPalClient): Promise<JudgeState> {
  const seed = findSeedRecord(store);
  const [invoices, orders, payouts] = await Promise.all([
    client.listInvoices(),
    client.listOrders(),
    client.listPayouts(),
  ]);
  const spinePlan = seed?.spinePlanId ? (store.getPlan(seed.spinePlanId) ?? null) : null;
  let spineInvoice: JudgeState["spineInvoice"] = null;
  if (seed && spinePlan) {
    // The executor records the created invoice id in the plan's audit rows.
    for (const rec of store.listActivity(spinePlan.id)) {
      const invoiceId = rec.detail?.invoiceId;
      if (typeof invoiceId === "string") {
        const inv = invoices.find((i) => i.id === invoiceId);
        if (inv) {
          spineInvoice = {
            id: inv.id,
            status: inv.status,
            amount: inv.amount.value,
            currency_code: inv.amount.currency_code,
          };
        }
      }
    }
  }
  return {
    seeded: seed !== null,
    seed,
    spinePlan,
    spineInvoice,
    counts: {
      invoices: invoices.length,
      orders: orders.length,
      payouts: payouts.length,
      plans: store.listPlans().length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Seeding                                                             */
/* ------------------------------------------------------------------ */

export interface JudgeSeedResult {
  alreadySeeded: boolean;
  seed: JudgeSeedRecord;
  state: JudgeState;
}

const ANA = { name: "Ana", email_address: "ana@example.com" };
const MARCO = { name: "Marco", email_address: "marco@example.com" };
const SAM = { name: "Sam Rivera", email_address: "sam@example.com" };

export async function seedJudgeScenario(
  client: PayPalClient,
  store: LedgerStore,
  options: { now?: Date } = {},
): Promise<JudgeSeedResult> {
  const existing = findSeedRecord(store);
  if (existing) {
    return { alreadySeeded: true, seed: existing, state: await getJudgeState(store, client) };
  }
  const now = options.now ?? new Date(JUDGE_REFERENCE_ISO);

  // 1) PAID history — Ana, USD 120 icon set.
  const paidInvoice = await client.createInvoice({
    recipient: ANA,
    items: [{ name: "Icon set", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }],
    dueDate: "2026-10-05",
  });
  await client.sendInvoice(paidInvoice.id);
  await client.recordInvoicePayment(paidInvoice.id, { value: "120.00", currency_code: "USD" });

  // 2) PARTIALLY_PAID + overdue history — Marco, EUR 300 consulting, EUR 100 paid.
  const partialInvoice = await client.createInvoice({
    recipient: MARCO,
    items: [{ name: "Consulting", quantity: "1", unit_amount: { currency_code: "EUR", value: "300.00" } }],
    dueDate: "2026-10-01",
  });
  await client.sendInvoice(partialInvoice.id);
  await client.recordInvoicePayment(partialInvoice.id, { value: "100.00", currency_code: "EUR" });

  // 3) Open SENT invoice — Sam Rivera, USD 280 landing page copy.
  const openInvoice = await client.createInvoice({
    recipient: SAM,
    items: [{ name: "Landing page copy", quantity: "1", unit_amount: { currency_code: "USD", value: "280.00" } }],
    dueDate: "2026-10-20",
  });
  await client.sendInvoice(openInvoice.id);

  // 4) COMPLETED checkout order — studio cable pack, USD 59, captured.
  const order = await client.createOrder({
    description: "Studio cable pack",
    amount: { currency_code: "USD", value: "59.00" },
  });
  await client.captureOrder(order.id);

  // 5) SUCCESS payout history — Marco, USD 80 hosting help.
  const payout = await client.createPayout({
    items: [{ recipient: MARCO, amount: { currency_code: "USD", value: "80.00" }, note: "Hosting help" }],
  });

  // 6) The demo-spine plan, parsed deterministically against the fixed
  // reference date (due "Friday" → 2026-10-16) and left pending approval.
  const spinePlan = store.addPlan(parseBrief(JUDGE_BRIEF, { now }));

  // 7) Historical events are history: mark every event emitted so far as
  // processed so a later sync/webhook redelivery can never replay the
  // historical INVOICE.PAID into the spine plan's gated payout.
  const carrier = client as unknown as { emittedEvents?: Array<{ id: string }> };
  const preProcessedEventIds: string[] = [];
  for (const event of carrier.emittedEvents ?? []) {
    if (store.markEventProcessed(event.id)) preProcessedEventIds.push(event.id);
  }

  const seed: JudgeSeedRecord = {
    spinePlanId: spinePlan.id,
    invoiceIds: [paidInvoice.id, partialInvoice.id, openInvoice.id],
    orderId: order.id,
    payoutBatchId: payout.batch_header.payout_batch_id,
    preProcessedEventIds,
  };
  store.record({
    kind: "system",
    summary:
      `Judge Mode scenario seeded (${JUDGE_SEED_ID}): 3 history invoices (PAID / PARTIALLY_PAID overdue / SENT), ` +
      `1 captured order, 1 successful payout, spine plan ${spinePlan.id} pending approval; ` +
      `${preProcessedEventIds.length} historical event(s) marked processed so they cannot resume the gated payout.`,
    detail: { judgeSeed: JUDGE_SEED_ID, ...seed },
  });

  return { alreadySeeded: false, seed, state: await getJudgeState(store, client) };
}

/* ------------------------------------------------------------------ */
/* Payment leg — record-payment + sync (the loop closer)               */
/* ------------------------------------------------------------------ */

export interface JudgePaymentResult {
  alreadyPaid: boolean;
  invoice: { id: string; status: Invoice["status"] };
  sync: SyncResult | null;
  /** Spine plan status after the payment leg (completed when the loop closed). */
  spinePlanStatus: ActionPlan["status"] | null;
}

export async function simulateJudgeInvoicePayment(
  client: PayPalClient,
  store: LedgerStore,
): Promise<JudgePaymentResult> {
  const state = await getJudgeState(store, client);
  if (!state.seeded || !state.spinePlan) {
    throw new JudgeModeError("Judge Mode is not seeded yet — load the scenario first.");
  }
  if (!state.spineInvoice) {
    throw new JudgeModeError(
      `Spine plan ${state.spinePlan.id} has not been executed yet — approve and execute it in the console first, then simulate the payment.`,
    );
  }
  const invoice = await client.getInvoice(state.spineInvoice.id);
  if (invoice.status === "PAID") {
    return {
      alreadyPaid: true,
      invoice: { id: invoice.id, status: invoice.status },
      sync: null,
      spinePlanStatus: store.getPlan(state.spinePlan.id)?.status ?? null,
    };
  }
  if (invoice.status !== "SENT" && invoice.status !== "PARTIALLY_PAID") {
    throw new JudgeModeError(
      `Spine invoice ${invoice.id} is ${invoice.status} — only a SENT invoice can be paid. Execute the spine plan first.`,
    );
  }
  // Record-payment for the full outstanding amount (mock/sandbox-local
  // path documented in CONCEPT.md §3.2), then let the sync reconciler
  // process the resulting INVOICING.INVOICE.PAID event exactly once —
  // the same code path a webhook delivery would take.
  const paid = await client.recordInvoicePayment(invoice.id, {
    value: invoice.due_amount.value,
    currency_code: invoice.due_amount.currency_code,
  });
  const sync = await syncFromPayPal(store, client);
  return {
    alreadyPaid: false,
    invoice: { id: paid.id, status: paid.status },
    sync,
    spinePlanStatus: store.getPlan(state.spinePlan.id)?.status ?? null,
  };
}
