# LedgerPilot

**An AI money operator for solo sellers and freelancers.**

Solo sellers and freelancers live in PayPal but drown in tabs: invoicing in one
place, checkout links in another, contractor payouts and dispute deadlines in
their head. Existing tools *record* money; nothing *operates* it for them.

LedgerPilot does. You say what happened in plain English —

> "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my
> contractor Marco."

— and LedgerPilot turns that brief into a typed action plan, shows you the
exact PayPal calls it will make, and executes **only after you approve**.
Money in (invoices, checkout orders), money out (payouts), and every step —
plan, approval, PayPal call, confirming webhook — is written to an auditable
operations console built on AG Grid.

> PayPal AI Hackathon entry. Sandbox / mock only — **no real money moves
> anywhere in this project**, and no real PayPal account is needed to run it.

---

## Judge quickstart (zero setup)

**Hosted demo:** the hosted Judge Mode URL is published with the Devpost
submission — open it and follow the 5-step script below. No PayPal account,
no API keys, no install.

**Local Judge Mode (same experience, ~1 minute):**

```bash
npm install
npm run dev        # http://localhost:3000
```

Then open **http://localhost:3000/judge** and click **Seed demo scenario**.

### What to click — the demo spine (5 steps)

1. **Seed.** On `/judge`, click *Seed demo scenario*. This loads a fictional
   seller history (a paid invoice, a partially-paid overdue invoice, an open
   invoice, a captured checkout order, a completed payout, and one clearly
   flagged *sample* dispute) plus the demo plan below, left waiting for your
   approval. Seeding is idempotent — clicking again changes nothing.
2. **Review the plan.** Open the console at `/`. In the **Agent Command bar**
   the plan is waiting: *Invoice Ana — USD 450.00, due Friday 2026-10-16*
   (`POST /v2/invoicing/invoices`) and *Payout to Marco — USD 200.00*, badged
   **"Runs after INVOICING.INVOICE.PAID"** (`POST /v1/payments/payouts`).
   Nothing has executed yet — that is the approval gate doing its job.
3. **Approve, then Execute.** The invoice is created and sent; the payout
   stays deferred (`awaiting_trigger`). Watch the Invoices grid: the new
   invoice is `SENT`, and the KPI strip shows it as outstanding.
4. **Simulate the payment.** Back on `/judge`, click *Simulate payment*. This
   is the documented local-run payment path: a mock-mode record-payment for
   the full amount, after which the sync reconciler processes the resulting
   `INVOICING.INVOICE.PAID` event exactly once — the same code path a real
   webhook delivery takes. The gated payout now fires on its own.
5. **See the loop close.** The invoice flips to `PAID`, the USD 200 payout to
   Marco lands as `SUCCESS`, the plan is `completed`, and the **Agent
   Activity & Webhook Audit** grid shows one unbroken trace: brief → plan →
   approval → PayPal calls → webhook → money. Try **Ask-the-grid** with
   *"Show everything still unpaid"* and watch the grids reconfigure.

Expected results after step 5 (Judge Mode, seeded history included):
collected USD 570.00 / EUR 100.00, outstanding EUR 200.00 / USD 280.00,
captured orders USD 59.00, payouts sent USD 280.00.

You can also drive the same flow from the console with your own briefs
(invoice, sell, payout, and reminder briefs all parse), or over HTTP:

```bash
curl -X POST localhost:3000/api/agent/plan -H 'content-type: application/json' \
  -d '{"brief":"Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco."}'
# → 201: a pending_approval plan with the exact PayPal calls listed
curl -X POST localhost:3000/api/agent/approve -H 'content-type: application/json' -d '{"planId":"plan-0001","decision":"approve"}'
curl -X POST localhost:3000/api/agent/execute -H 'content-type: application/json' -d '{"planId":"plan-0001"}'
# → invoice SENT now; payout deferred (awaiting_trigger) until INVOICING.INVOICE.PAID
```

---

## What LedgerPilot does

- **Brief → typed plan.** A deterministic parser turns plain English into a
  typed action plan (`create_invoice` / `create_order` / `draft_payout` /
  `send_reminder`) with exact amounts, currencies ($/€/£), relative due dates
  ("due Friday", "in 5 days", "tomorrow"), and trigger gating ("when it
  lands, pay…" defers a payout until the invoice-paid event arrives).
- **Approval gate (the trust invariant).** No plan executes without an
  explicit approve decision, enforced server-side: unapproved or rejected
  plans execute nothing, and re-executing a settled plan is refused (409).
  Trigger-gated steps resume only via a verified webhook or the sync
  reconciler — never via a second execute call.
- **Verified, idempotent webhooks.** `POST /api/paypal/webhooks` verifies the
  event signature through the PayPal adapter before trusting the payload
  (unverified events are rejected, audited, and never marked processed),
  deduplicates by event id (a redelivery is acknowledged as a duplicate and
  never causes a second PayPal call), and resumes gated plan steps.
  Resumption is resource-correlated: a gated step is bound at execution
  time to the invoice its own plan created, so one invoice's payment can
  never release another plan's payout — a mismatched event is audit-logged
  and the step stays gated.
- **Sync reconciler.** `GET /api/paypal/sync` is the polling fallback for
  instances webhooks cannot reach: it drains undelivered events in order and
  sweeps resource state with stable synthetic event ids, so repeat syncs are
  no-ops. It never calls a mutating PayPal endpoint.
- **Operations console (AG Grid).** Four first-class grids — **Invoices**,
  **Orders / Checkout**, **Payouts**, and **Agent Activity & Webhook Audit** —
  plus two read-only surfaces: **Disputes** (buyer, reason, amount, lifecycle
  stage, and the seller-response deadline, overdue responses highlighted;
  seeded demo rows are always flagged "Sample") and **Reconciliation —
  Transaction Search** (the signed money ledger: invoice payments in,
  payout batches out). All grids have sorting, column + floating filters,
  pagination, and status pills. Money totals are grouped **per currency and
  never summed across currencies**. AG Grid Community edition only (no trial
  watermark).
- **Honest console states.** Loading, load-error, empty, and filtered-empty
  are four different states with four different messages — resolved by a
  pure, unit-tested view-model, never a bare grid: a fresh console explains
  itself and points at Judge Mode, a failed refresh keeps any rows already
  on screen (the error lives in the banner, with a retry), and a filter
  that hides every row says so instead of claiming there is no data.
- **Ask-the-grid.** A plain-English question ("show unpaid invoices over
  $200 from this month") is compiled by the deterministic parser into a
  *validated* AG Grid filter model: per-grid status vocabulary (paid = PAID
  invoices / COMPLETED orders / SUCCESS payouts), amounts with currency,
  recipients, overdue (open + due date in the past), and relative dates.
  Only whitelisted columns, filter types, and operators can ever reach the
  grid; every emitted model is validated before it is applied.
- **Judge Mode.** `/judge` seeds the fictional scenario above (all customers
  are invented; the one sample dispute is explicitly flagged `sample: true`)
  and explains exactly what will happen before it happens.

## Run it locally

### Mock mode (default — no credentials, no keys)

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # full test suite (141 tests)
npm run typecheck  # tsc --noEmit
npm run build      # production build
```

Mock mode (`PAYPAL_MODE=mock`) implements the full PayPal surface used by
LedgerPilot — Invoicing v2, Orders v2, Payouts, webhook signature
verification, Disputes and Transaction Search (read-only) — against in-memory
fixtures, so the whole loop runs with zero setup.

### Sandbox mode (optional — your own sandbox app)

Set `PAYPAL_MODE=sandbox` and provide **your own** PayPal Developer sandbox
credentials (see `.env.example`): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_WEBHOOK_ID`. Sandbox Business/Personal (buyer) test accounts are
created inside your own developer dashboard; the hosted Judge Mode needs
none of this. Status: the sandbox adapter now implements the full REST
surface behind the same contract — OAuth token fetch with caching,
Invoicing v2, Orders v2, Payouts, Disputes + Transaction Search
(read-only), and webhook signature verification — and that wiring is unit
tested against a stub HTTP layer with fake credentials. It has **not yet
been exercised against the live sandbox** (that needs a real sandbox app);
mock mode remains the default and nothing in it depends on the sandbox
adapter. Two PayPal shapes worth knowing: create-invoice returns only
HATEOAS links, so the adapter reads the id from the `self` link and then
GETs the invoice; and Orders v2 has no list endpoint, so listing re-GETs
the orders this process created.

### Environment

See `.env.example`. `PAYPAL_MODE=mock|sandbox`; sandbox credentials and the
optional LLM key are only read from your own environment — none are
committed.

## Architecture

Single Next.js (App Router) + TypeScript app. App code never calls PayPal
directly — everything goes through one adapter contract, which is what makes
mock mode a config swap rather than a rewrite.

- `src/lib/types.ts` — domain types mirroring the PayPal REST resources,
  plus the typed agent action plan.
- `src/lib/paypal/client.ts` — the `PayPalClient` adapter contract.
- `src/lib/paypal/mock.ts` — mock adapter (default): full in-memory
  implementation with fictional seed data, invoice lifecycle incl. partial
  payments, emitted webhook events, and a deterministic mock
  webhook-signature scheme that mirrors the real verify flow's shape.
- `src/lib/paypal/sandbox.ts` — sandbox adapter: live REST wiring behind
  the same contract (OAuth + token cache, all resource mappings, PayPal
  error translation), with an injectable fetch/clock so it is fully unit
  tested offline with fake credentials.
- `src/lib/agent/parser.ts` — deterministic NL brief → typed action plan
  parser (no LLM, no keys; relative due dates resolved against an injectable
  reference date).
- `src/lib/agent/llm.ts` — the optional LLM adapter: env-gated config
  (null without `LLM_API_KEY`), an OpenAI-compatible chat-completions client
  with an injectable fetch, the strict extraction validator, the
  deterministic extraction→plan conversion, and `parseBriefWithFallback`
  (deterministic-first; LLM only on a parser miss; failures rethrow the
  parser's error).
- `src/lib/agent/store.ts` — in-memory ledger: plans, the append-only
  activity/audit log, and webhook event-id idempotency.
- `src/lib/agent/executor.ts` — the only path from an approved plan to
  PayPal calls; trigger-gated steps are deferred and resumed by
  `resumeTriggeredSteps` when the matching event arrives.
- `src/lib/agent/webhooks.ts` — webhook handling: signature verification
  through the adapter, event-id idempotency, audit logging, trigger resume.
- `src/lib/agent/reconciler.ts` — polling fallback (`syncFromPayPal`).
- `src/lib/console/` — console read models: pure projections (invoice rows
  with overdue flags, order rows with capture state, payout rows flattened
  one-per-item with batch context, activity/audit rows, dispute rows with
  response deadlines + sample flags, transaction rows for reconciliation,
  per-currency KPI totals), plus the console-state view-model (`states.ts`):
  loading / error / empty / filtered-empty resolution, overlay templates, the
  console banner, and KPI/caption rules.
- `src/lib/command/` — Agent Command bar view-model: brief validation,
  example briefs, the plan-review model (step labels, exact PayPal call,
  trigger badges), and action-availability rules that mirror the server-side
  approval gate.
- `src/lib/ask/` — Ask-the-grid parser + filter-model validator.
- `src/lib/judge/` — Judge Mode scenario descriptor, idempotent seeder
  (historical events pre-marked processed, so a later sync can never replay
  them into the gated payout), live spine state, and the record-payment +
  sync payment leg.
- API routes — `src/app/api/agent/` (`POST /plan`, `POST /approve`,
  `POST /execute`), `src/app/api/paypal/` (`POST /webhooks` — 401 on bad
  signature, 200 on processed/duplicate; `GET /sync`),
  `src/app/api/console/` (`GET /invoices|orders|payouts|activity|disputes|transactions|summary`),
  `src/app/api/judge/` (`GET /`, `POST /seed`, `POST /pay`).
- UI — `src/app/` (operations console at `/`, Judge Mode at `/judge`).

## PayPal APIs used

| API | How LedgerPilot uses it |
|---|---|
| **Invoicing v2** | Create/send invoices from briefs; get/list; record-payment for the local-run payment path |
| **Orders v2 / Checkout** | Create + capture checkout orders for one-off sales ("sell" briefs) |
| **Payouts** | Batch payouts drafted by the agent, released only after approval; per-item status tracked |
| **Webhooks** | `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED` — signature-verified, idempotent event log |
| **Disputes (read-only)** | Own console grid: open disputes with buyer, reason, stage, and seller-response deadlines; seeded Judge Mode includes one explicitly flagged sample row, because sandbox disputes cannot be reliably manufactured |
| **Transaction Search (read-only)** | The console's Reconciliation grid: the signed transaction ledger (payments in, payouts out) behind the KPI totals |

In mock mode all of the above run against the mock adapter, whose method
signatures mirror the REST resources one-to-one.

## AI tools used

- **Deterministic agent (built for this project, the default brain).** A
  rule/parser-based engine — not an LLM wrapper — compiles briefs into typed
  action plans and Ask-the-grid questions into validated filter models. It
  needs no API key, behaves identically on every run, and is fully auditable:
  the plan a judge approves is the plan that executes.
- **Optional LLM adapter (off by default).** Any OpenAI-compatible endpoint
  via `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`. It is a *fallback*, not
  a replacement: the deterministic parser always runs first, and the LLM is
  consulted only for a brief the parser cannot read. Its JSON extraction is
  validated field-by-field in code (step-type and currency whitelists,
  positive amounts under a hard cap, real ISO due dates) and converted into
  a plan by deterministic code — an invalid or failed LLM response falls
  back to the parser's original error. LLM-sourced plans are marked
  `source: "llm"` and pass through the same approval gate. The app is fully
  functional with the LLM unset; no feature, including Judge Mode, requires
  it.
- **Development tooling.** This project was built with AI coding assistance
  (Muse). All PayPal flows, the approval-gate invariant, and the webhook
  idempotency semantics are covered by the automated test suite below.

## Testing

```bash
npm test           # vitest — 141 tests, all green
npm run typecheck  # TypeScript strict, clean
npm run build      # Next.js production build
```

The suite covers: the mock PayPal surface (invoice lifecycle, partial
payments, capture/payout guards, the full invoice→paid→payout loop), the
agent pipeline (brief parsing incl. due-date forms and currencies, the
approval gate, trigger resume, audit ordering), webhooks + reconciler
(bad-signature rejection, duplicate delivery, webhook/reconciler
non-interference, resource-correlated trigger resumption), console read
models (per-currency totals, overdue flags, dispute response deadlines +
sample flags, signed reconciliation ledger), console states (loading /
error / empty / filtered-empty precedence, overlay HTML escaping, banner
and KPI rules), the command-bar gate matrix, Ask-the-grid parsing +
validator negative cases, the full Judge Mode loop (seed idempotency,
the historical-event guard, double-payment no-op), and the sandbox REST
adapter against a stub fetch (OAuth caching/expiry, the links-only
create-invoice flow, order capture + list-by-id, payout mapping, the
nested Transaction Search shape, webhook verification SUCCESS/FAILURE,
and PayPal error translation), and the optional LLM adapter (config
gating, deterministic-first non-consultation, validator negative cases,
fallback error honesty, and a full approval-gated loop from an
LLM-sourced plan) — fake credentials only, no network.

## Demo

- **Hosted demo:** URL published with the Devpost submission (Judge Mode,
  zero setup).
- **Demo video:** public YouTube link published with the Devpost submission
  (≤ 3 minutes, screen recording of the 5-step spine above).

## License

MIT — see [LICENSE](./LICENSE).
