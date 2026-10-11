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
- **Resource-shaped plan drafts (the REST API respects the gate too).**
  `POST /api/paypal/invoices`, `POST /api/paypal/orders`, and
  `POST /api/paypal/payouts` are thin, validated wrappers over Invoicing
  v2 / Orders v2 / Payouts — but they *draft* a typed action plan
  (`source: "api"`, `pending_approval`) instead of calling PayPal, so
  the approval gate has no REST back door: nothing is created, sent, or
  paid until the plan is approved and executed through the ordinary
  agent flow, and the drafted steps are payload-identical to the NL
  parser's. A payout draft may name `payWhenInvoicePaid` to gate itself
  on one specific invoice's payment event (resource-correlated, like
  every gated step). Invalid input (bad currency, non-positive or
  over-cap amount, impossible due date, malformed email) is a 400 with
  the reason — never a half-valid plan.
- **Payout batch builder (drafted batch, per-line validation, approval
  release).** The payouts draft also accepts a batch form —
  `{ items: [{ recipientName, amount, currency?, note? }, … ] }` (up to
  25 lines) — where every line is validated on its own and a failure
  names the line (`items[1]: 'amount' must be greater than zero`);
  mixing the batch and single-recipient forms is rejected as ambiguous.
  The drafted step executes as exactly **one** PayPal Payouts batch
  after approval — never fanned out into per-line calls — and the
  console's Payouts grid flattens it to one row per recipient under the
  single batch id. A batch may be gated on one invoice's payment like
  any payout draft, and then releases whole, exactly once. The console
  ships the builder as a form (above the Payouts grid): add/remove
  lines, per-line inline validation mirroring the server's rules, a
  live per-currency totals preview, an optional batch note and
  invoice gate, and the same plan review → approve → execute gate —
  the form only ever drafts via the API above.
- **Verified, idempotent webhooks.** `POST /api/paypal/webhooks` verifies the
  event signature through the PayPal adapter before trusting the payload
  (unverified events are rejected, audited, and never marked processed),
  deduplicates by event id (a redelivery is acknowledged as a duplicate and
  never causes a second PayPal call), and resumes gated plan steps.
  Resumption is resource-correlated: a gated step is bound at execution
  time to the invoice its own plan created, so one invoice's payment can
  never release another plan's payout — a mismatched event is audit-logged
  and the step stays gated.
- **Invoice reminders that actually send.** A `send_reminder` step calls
  the real remind endpoint (`POST /v2/invoicing/invoices/:id/remind`)
  through the adapter — mock and sandbox alike. The target invoice is
  resolved deterministically at execution: an explicit invoice reference
  must match an invoice id, number, or reference (an unmatched reference
  fails the step — a reminder is never sent to the wrong invoice and
  never silently downgraded to a draft), and with no reference the
  recipient's most-overdue open invoice wins. The adapter refuses
  non-open invoices (a reminder for a PAID invoice fails honestly).
- **Checkout capture leg (the sell loop closes).** A `create_order` step
  creates a `CREATED` order. The Orders grid's **Buyer view** column
  surfaces the order's PayPal checkout link — the `approve` (or
  `payer-action`) HATEOAS link the buyer opens to approve the order —
  resolved by a pure, unit-tested view-model: a payable order links
  out (mock-mode links are labeled "Open mock checkout", never
  disguised as a real PayPal page), a captured order reads "Paid via
  checkout" and offers no link again, and an order PayPal returned no
  approval link for honestly reads "No checkout link" — a link is
  never invented. The buyer-side completion lives in the same grid
  (**Capture** button) and at `POST /api/paypal/orders/capture`. Capture goes through the adapter,
  is written to the audit log as the exact call, and the resulting
  `PAYMENT.CAPTURE.COMPLETED` event is processed by the sync reconciler
  — the same code path a webhook delivery takes. It is deliberately
  *not* an agent action: capturing is what the buyer does by completing
  checkout (in sandbox mode PayPal itself refuses capture before buyer
  approval), so it needs no plan approval and does not weaken the gate.
  Re-capturing a `COMPLETED` order is an `alreadyCaptured` no-op; a
  `VOIDED` or unknown order is an honest error, and an adapter refusal
  is audit-logged as a failed capture.
- **Sync reconciler.** `GET /api/paypal/sync` is the polling fallback for
  instances webhooks cannot reach: it drains undelivered events in order and
  sweeps resource state with stable synthetic event ids, so repeat syncs are
  no-ops. It never calls a mutating PayPal endpoint.
- **Optional ledger persistence.** The ledger store (plans, the append-only
  audit log, webhook event-id idempotency) is in-memory by default. Set
  `LEDGERPILOT_STORE_FILE` to a JSON file path and every mutation is written
  through to a versioned snapshot (temp file + atomic rename), so a hosted
  single-process instance keeps its plans, audit trail, and idempotency
  across restarts — activity ids continue the sequence and never repeat.
  A corrupt or unsupported snapshot fails loudly at startup instead of
  silently discarding the audit log. This is a zero-dependency snapshot
  store, not a multi-writer database (one server process per file);
  PayPal resources are not stored in it — in sandbox mode they live at
  PayPal and are re-fetched. In mock mode the adapter now has the
  matching opt-in: set `PAYPAL_MOCK_STORE_FILE` to a JSON file path and
  the mock persists its invoices, orders, payout batches, transactions,
  disputes, emitted events, sent reminders, and the id sequence through
  the same versioned-snapshot discipline (atomic rename, loud refusal
  of a corrupt snapshot instead of silently reseeding). With both
  files set, a mock-mode restart loses nothing — a plan left in
  `awaiting_trigger` still finds its invoice, and the gated payout
  resumes exactly once when the payment lands.
- **Operations console (AG Grid).** Four first-class grids — **Invoices**,
  **Orders / Checkout**, **Payouts**, and **Agent Activity & Webhook Audit** —
  plus two read-only surfaces: **Disputes** (buyer, reason, amount, lifecycle
  stage, and the seller-response deadline, overdue responses highlighted;
  seeded demo rows are always flagged "Sample") and **Reconciliation —
  Transaction Search** (the signed money ledger: invoice payments in,
  payout batches out). Each dispute row has an **Evidence draft** action:
  a deterministic, draft-only **dispute-evidence summary** assembled from
  the dispute record, Transaction Search, and the seller's invoices —
  verified facts, an evidence checklist, the gaps the seller must still
  fill (delivery proof is always a gap: LedgerPilot holds no shipping
  data and never asserts it), and a response draft for seller review.
  It is never submitted — the Disputes integration is read-only.
  Clicking an invoice number opens its **detail
  page** (`/invoices/[id]`): billed/collected/still-due amounts, line
  items, the plans related to it, and a chronological **status timeline**
  projected from the audit log — every agent call, verified webhook
  delivery (with its event id), rejected-signature attempt, and
  sync-reconciler processing that concerned this invoice, and nothing
  invented for invoices that predate the trail. All grids have sorting, column + floating filters,
  pagination, status pills, and a per-grid **Export CSV** button (dated
  file name, disabled while loading or when the grid is empty). When a
  refresh shows a row's state flipped — the invoice that just turned
  `PAID`, a capture completing, a payout landing — that row **flashes**,
  so a webhook-driven change is visible the moment it lands. Money
  totals are grouped **per currency and
  never summed across currencies**. AG Grid Community edition only (no trial
  watermark) — which is also why there is no in-grid row grouping:
  grouping is an AG Grid Enterprise feature, so the Activity grid's
  Plan column + filter serves as the grouping substitute instead of
  loading a licensed module.
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
  and explains exactly what will happen before it happens. When a run is
  finished, **Reset demo** returns the instance to a clean slate — every
  plan, audit record, and mock resource cleared, the sample dispute
  restored — so the next judge (or the next video take) can seed and run
  the scenario from the top. Reset is mock-mode only and refuses in
  sandbox mode: sandbox resources live at PayPal and cannot be cleared
  from here. Id sequences never rewind across a reset, so no invoice,
  plan, or event id is ever reused.
- **Deployment readiness.** `GET /api/health` reports whether this instance
  can actually do PayPal work — effective mode, sandbox credentials /
  webhook id configured (booleans + missing-variable names only, never a
  secret value), persistence, and LLM state — as `ok` / `degraded` /
  `misconfigured` with per-check explanations. It is built from the
  environment alone and never constructs the runtime, so it diagnoses the
  exact case where every other route fails: sandbox mode deployed without
  credentials answers 503 here (naming `PAYPAL_CLIENT_ID` /
  `PAYPAL_CLIENT_SECRET`) instead of an opaque 500. Warnings only (e.g.
  sandbox without a webhook id — the sync reconciler remains the fallback)
  stay 200 `degraded`; mock mode is always `ok`.
- **Branded app shell.** The App Router special files are LedgerPilot's own,
  not the framework defaults: a mistyped or moved link lands on a branded
  404 that routes back to the console and Judge Mode; a page error renders
  a recovery surface with a Try-again (reset) action that never shows the
  raw error message or stack (only the opaque support digest), with a
  self-contained global-error fallback for a failure in the root layout
  itself; the loading state is an accessible live region that points at
  `GET /api/health`. The app icon (`src/app/icon.svg`, a ledger-lines mark)
  is served by file convention, and `robots.txt` allows the public pages
  while keeping the `/api/` machine surface out of search indexes — no
  sitemap or host is declared, because no public URL exists to declare
  before the hosted deployment.

## Run it locally

Node 22 is the pinned runtime (`.nvmrc` + the `package.json` `engines`
floor; CI and the Render blueprint pin the same major — newer majors
are not blocked, the suite also runs on them).

### Mock mode (default — no credentials, no keys)

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # full test suite (338 tests)
npm run typecheck  # tsc --noEmit
npm run build      # production build
```

Mock mode (`PAYPAL_MODE=mock`) implements the full PayPal surface used by
LedgerPilot — Invoicing v2, Orders v2, Payouts, webhook signature
verification, Disputes and Transaction Search (read-only) — against in-memory
fixtures, so the whole loop runs with zero setup. Its state is in-memory by
default; `PAYPAL_MOCK_STORE_FILE` (see Environment) makes it survive
restarts.

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
committed. `LEDGERPILOT_STORE_FILE` (optional) turns on ledger persistence
to a JSON snapshot file; unset, the ledger is in-memory.
`PAYPAL_MOCK_STORE_FILE` (optional, mock mode only) does the same for the
mock adapter's resources; unset, they are in-memory too.

### Hosted deployment

`render.yaml` (repo root) is a Render Blueprint for the hosted demo:
one free-tier Node web service that builds with `npm ci && npm run build`,
starts with `npm start` (Next.js binds Render's `$PORT`), and is
health-checked at `GET /api/health`. It deploys in the default mock
mode, so Judge Mode works the moment the service is up — no PayPal
account, no keys. Every credential-shaped variable is declared
`sync: false`: Render prompts for the value at deploy time and no
secret value is ever stored in this repository. On the free tier the
filesystem is ephemeral, so leave the two snapshot-file variables
unset (a restart returns the demo to its fresh state; re-seed — or
reset via `POST /api/judge/reset` — in seconds). The blueprint's shape
is pinned by the test suite, and the variables it lists match
`.env.example` exactly. On Vercel no descriptor is needed: import the
repo, keep the default Next.js settings, and set the same environment
variables.

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
  Opt-in file persistence (`PAYPAL_MOCK_STORE_FILE`, wired by the client
  factory) snapshots every resource + the id sequence with the same
  versioned/atomic/loud-on-corrupt discipline as the ledger store.
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
- `src/lib/agent/store.ts` — the ledger: plans, the append-only
  activity/audit log, and webhook event-id idempotency. In-memory by
  default; with `LEDGERPILOT_STORE_FILE` set it is a file-backed
  snapshot store (versioned JSON, atomic rename, loud failure on a
  corrupt snapshot), wired into the runtime by `ledgerStoreFromEnv`.
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
  per-currency KPI totals), the console-state view-model (`states.ts`:
  loading / error / empty / filtered-empty resolution, overlay templates,
  the console banner, and KPI/caption rules), and the grid-tools
  view-model (`grid-tools.ts`: CSV export naming/gating + change-flash
  detection).
- `src/lib/command/` — Agent Command bar view-model: brief validation,
  example briefs, the plan-review model (step labels, exact PayPal call,
  trigger badges), and action-availability rules that mirror the server-side
  approval gate.
- `src/lib/batch/` — payout batch builder view-model: form-line
  editing guards (1–25 lines), the per-line validation mirror of the
  server rules, request-body building, and the live per-currency
  totals preview for the console's batch form.
- `src/lib/ask/` — Ask-the-grid parser + filter-model validator.
- `src/lib/checkout/` — the Orders checkout leg: the buyer-view
  resolution (`checkout-link.ts`: approval-link extraction —
  `approve` before `payer-action`, mock links flagged — plus the
  payable / captured / voided / unavailable view states projected
  into the Orders grid rows) and the capture leg (buyer-side checkout
  completion for a created order: status guards, audit record, capture
  event processed via the reconciler, idempotent re-capture).
- `src/lib/disputes/` — draft-only dispute-evidence summaries:
  deterministic assembly from the dispute record, Transaction Search,
  and invoices (conservative matching, evidence checklist + gaps,
  urgency from the response deadline; nothing is ever submitted).
- `src/lib/judge/` — Judge Mode scenario descriptor, idempotent seeder
  (historical events pre-marked processed, so a later sync can never replay
  them into the gated payout), live spine state, the record-payment +
  sync payment leg, and the mock-mode demo reset (`LedgerStore.reset` +
  `MockPayPalClient.reset`, refusing in sandbox mode).
- `src/lib/health/` — the deployment-readiness report behind
  `GET /api/health`: a pure function of the environment + an injected
  clock (effective mode with the factory's mock fallback, sandbox
  credential/webhook presence as booleans, persistence and LLM state),
  resolving to `ok` / `degraded` / `misconfigured` checks. It never
  constructs the runtime or a PayPal client and never reports a secret
  value — only the names of missing variables.
- API routes — `GET /api/health` (readiness; 200 ok/degraded, 503
  misconfigured), `src/app/api/agent/` (`POST /plan`, `POST /approve`,
  `POST /execute`), `src/app/api/paypal/` (`POST /invoices|orders|payouts` —
  validated wrappers that draft plans, never execute; `POST /webhooks` — 401 on bad
  signature, 200 on processed/duplicate; `GET /sync`; `POST /orders/capture`),
  `src/app/api/console/` (`GET /invoices|orders|payouts|activity|disputes|transactions|summary`,
  plus `GET /invoices/[id]` for the detail projection and
  `GET /disputes/[id]/evidence` for the draft-only evidence summary),
  `src/app/api/judge/` (`GET /`, `POST /seed`, `POST /pay`, `POST /reset`).
- UI — `src/app/` (operations console at `/`, Judge Mode at `/judge`,
  invoice detail at `/invoices/[id]`).

## PayPal APIs used

| API | How LedgerPilot uses it |
|---|---|
| **Invoicing v2** | Create/send invoices from briefs; get/list; record-payment for the local-run payment path; send payment reminders (`POST /v2/invoicing/invoices/:id/remind`) for open invoices |
| **Orders v2 / Checkout** | Create checkout orders for one-off sales ("sell" briefs); the buyer approval link (`approve` / `payer-action`) is surfaced in the console's Buyer view column; capture on buyer checkout completion (console Capture action / `POST /api/paypal/orders/capture`) |
| **Payouts** | Batch payouts drafted by the agent, released only after approval; per-item status tracked |
| **Webhooks** | `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED` — signature-verified, idempotent event log |
| **Disputes (read-only)** | Own console grid: open disputes with buyer, reason, stage, and seller-response deadlines, plus a per-dispute Evidence draft (deterministic summary from the dispute record + Transaction Search + invoices; draft only, never submitted); seeded Judge Mode includes one explicitly flagged sample row, because sandbox disputes cannot be reliably manufactured |
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
npm test           # vitest — 338 tests, all green
npm run typecheck  # TypeScript strict, clean
npm run build      # Next.js production build
```

The same sequence runs in CI (`.github/workflows/ci.yml`) on every
push to `main` and every pull request — no secrets required, since
the suite is fully offline and the build runs in mock mode.

The suite covers: the mock PayPal surface (invoice lifecycle, partial
payments, capture/payout guards, the full invoice→paid→payout loop),
the checkout buyer view (approve-link extraction with payer-action
fallback, mock links flagged, captured orders never re-offered a pay
link, voided / link-less states honest, order-row projection through
a real mock create → capture loop),
the checkout capture leg (an agent-created order captured to COMPLETED
with the capture event processed once, re-capture no-op, unknown /
VOIDED / adapter-refusal paths audit-logged),
invoice reminders (mock open-invoice rules, executor resolution by
reference and by most-overdue open invoice, unmatched-reference and
already-paid failures, the sandbox `/remind` request shape), the
agent pipeline (brief parsing incl. due-date forms and currencies, the
approval gate, trigger resume, audit ordering), webhooks + reconciler
(bad-signature rejection, duplicate delivery, webhook/reconciler
non-interference, resource-correlated trigger resumption), console read
models (per-currency totals, overdue flags, dispute response deadlines +
sample flags, signed reconciliation ledger), dispute-evidence summaries (reason labels, exact-id transaction matching, buyer+amount invoice matching, overdue/due-soon urgency, delivery proof always a gap, unknown-id 404), console states (loading /
error / empty / filtered-empty precedence, overlay HTML escaping, banner
and KPI rules), console grid tools (dated CSV export
file names + export gating, change-flash detection — a SENT→PAID flip
flashes, new rows never do, append-only grids watch nothing), the
command-bar gate matrix, Ask-the-grid parsing +
validator negative cases, the full Judge Mode loop (seed idempotency,
the historical-event guard, double-payment no-op), and the sandbox REST
adapter against a stub fetch (OAuth caching/expiry, the links-only
create-invoice flow, order capture + list-by-id, payout mapping, the
nested Transaction Search shape, webhook verification SUCCESS/FAILURE,
and PayPal error translation), and the optional LLM adapter (config
gating, deterministic-first non-consultation, validator negative cases,
fallback error honesty, and a full approval-gated loop from an
LLM-sourced plan), and the resource plan drafts behind
`POST /api/paypal/invoices|orders|payouts` (parser-identical payloads,
the no-execution-without-approval invariant over HTTP-shaped inputs,
a payout gated on a named invoice firing only for that invoice, and
the validation rejection matrix), payout batches (per-line validated
batch drafts with line-named errors and the ambiguous-shape rejection,
drafting moves no money, an approved batch executing as exactly one
PayPal batch with per-item console rows and per-currency totals, a
batch gated on one invoice releasing whole and only for that invoice,
and an explicitly empty items list failing the plan), the batch
builder form view-model (line editing guards, the per-line validation
mirror naming line + field, request-body normalisation, per-currency
totals that skip invalid lines, and a form-built batch — example
included — accepted by the real draft and paid as one batch through
the gate), and the invoice detail projection
(timeline correlation rules for executor / webhook / sync / seed
records, the rejected-signature entry, partial-payment state without
an invented PAID event, seeded and adapter-direct invoices, and
trigger-bound related plans), and the optional ledger persistence
(in-memory default + blank-env handling, a full executed plan restored
after a simulated restart with its trigger binding, activity sequence,
and webhook idempotency intact, bare status updates persisted, the
versioned snapshot shape with no temp file left behind, and loud
refusal — without overwriting — of corrupt or unsupported snapshots),
and the optional mock-adapter persistence (in-memory default + blank-env
handling, a full resource round-trip — invoices/orders/payouts/
transactions/events/reminders/disputes — restored after a simulated
restart with no sample-dispute duplication, id-sequence continuation,
the versioned snapshot shape, loud refusal of corrupt or unsupported
snapshots, and the whole invoice→paid→payout loop closing across a
restart when both stores are file-backed), and the deployment
readiness report (mock default ok, unknown mode degraded with the
mock fallback named, sandbox fully configured ok, sandbox missing
credentials misconfigured → 503 naming exactly the missing variables,
sandbox without a webhook id degraded with the sync fallback noted,
blank values treated as unset, stable check ordering, and a
secret-safety guarantee: no env credential value ever appears in the
serialized report), and the Judge Mode demo reset (store + mock
clearance counts, activity/resource ids never reused after a reset,
the sample dispute restored exactly once — and not restored for a
`sampleDispute: false` client — a completed loop resetting to a clean
slate and closing a second time under a new plan id, sandbox-mode and
no-reset-adapter refusals that touch nothing, and emptied file-backed
snapshots reopening fresh), and the deployment descriptor
(`render.yaml` — one free-tier Node service building and starting with
the package's own scripts, the health check probing the real
`/api/health` route, mock mode as the credential-free default, every
credential variable `sync: false` with no value stored anywhere in the
file, and the blueprint's variable list matching `.env.example` in
both directions), and the repository health files (`SECURITY.md` —
private vulnerability reporting, the sandbox/mock-only scope, the
enforced approval-gate / webhook / secrets model, the Judge Mode
demo-controls warning, no invented contact address — and
`.github/dependabot.yml` — npm + github-actions ecosystems, weekly,
bounded open PRs, proposals only with no auto-merge and no secrets),
and the contributor facade (`CONTRIBUTING.md` — the exact CI gate in
order, the enforced invariants, security flaws routed privately,
fictional demo data — plus the issue forms in
`.github/ISSUE_TEMPLATE/` — bug form with mode + reproduction steps,
feature form carrying the scope and the approval gate, blank issues
disabled — and `.github/pull_request_template.md` — the gate,
secrets, and money rules as a checklist), and the Node runtime pin
(`.nvmrc` naming the pinned major, the `package.json` `engines` floor
at that major, CI and the Render blueprint pinning the same major,
`@types/node` tracking it, and CONTRIBUTING.md stating it — a version
bump must move all five sites at once), and the code of conduct
(`CODE_OF_CONDUCT.md` — Contributor Covenant 2.1 pledge and standards,
the four-step enforcement ladder in order, conduct reports routed
privately through GitHub with no public issue and no invented contact
address, referenced from CONTRIBUTING.md), and the changelog
(`CHANGELOG.md` — Keep a Changelog format, everything under
Unreleased with no version claimed as released before the public
launch, the pending version agreeing with `package.json`, the
shipped capabilities and the honesty notes — sandbox not yet
live-verified, AG Grid Community only, money never summed across
currencies — all pinned), and the HTTP security headers
(`next.config.mjs` — one header set applied to every route, the
same-origin Content-Security-Policy with no wildcard or external
origin and frame-ancestors 'none', HSTS without a preload claim,
nosniff / DENY framing / strict-origin referrer / device-feature
denials, eval and the HMR socket scoped to development only, and
the framework header disabled — all pinned), and the app shell
special files (the branded 404 routing back to the console and
Judge Mode, the client error boundary retrying via `reset` and
never rendering the error message or stack, the global-error
fallback carrying its own html/body shell, the accessible loading
region, the self-contained `icon.svg` with no external references,
and `robots` allowing the pages while disallowing `/api/` — the
robots function's return value is asserted directly)
— fake credentials only, no network.

## Demo

- **Hosted demo:** URL published with the Devpost submission (Judge Mode,
  zero setup).
- **Demo video:** public YouTube link published with the Devpost submission
  (≤ 3 minutes, screen recording of the 5-step spine above).

## Security

See [SECURITY.md](./SECURITY.md): report vulnerabilities privately
through GitHub, never in a public issue. LedgerPilot runs against the
PayPal sandbox and a local mock only — there is no real-money mode,
credentials come from your own PayPal Developer app via environment
variables, and the public hosted demo runs credential-free in mock
mode. Every response carries the HTTP security headers
configured in `next.config.mjs` (same-origin
Content-Security-Policy, HSTS, anti-sniffing and anti-framing
headers — see SECURITY.md for the full model). Dependency updates arrive as Dependabot pull requests
(`.github/dependabot.yml`); every proposal is gated by CI and human
review, nothing auto-merges.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md): the verification gate
(typecheck → test → build, exactly what CI runs), the invariants a
change must not break (approval gate, deterministic-first AI,
verified webhooks, per-currency money, labeled sample data), and
how to report bugs through the issue templates. Security flaws
never go in a public issue — see the Security section above.
Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
(Contributor Covenant 2.1); conduct concerns are likewise reported
privately through GitHub, never in a public issue.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) (Keep a Changelog format).
LedgerPilot has not been publicly released yet — the first public
release, 0.1.0, launches with the public repository on 2026-11-01,
so all changes are listed under Unreleased until then.

## License

MIT — see [LICENSE](./LICENSE).
