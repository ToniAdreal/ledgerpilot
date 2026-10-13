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
- **Plan amendment (the plan-review Edit).** CONCEPT.md §3.1's plan
  review is "Approve / Edit / Reject" — the Edit is amounts:
  `POST /api/agent/edit` amends the amount/currency of a pending plan's
  money steps (a batch payout step per line) so a reviewer who spots a
  wrong amount no longer rejects and re-drafts from scratch. The rules
  keep the gate honest: only a plan in `pending_approval` can be
  amended (an approved plan is immutable through this path — approval
  always covers exactly the steps the reviewer saw), every amount is
  validated through the resource drafts' own money rules (positive,
  ≤ 100,000, USD/EUR/GBP), each amended step's description is
  regenerated in its builder's exact format, the amendment (old → new
  per step) is written to the audit log, the plan's brief is never
  rewritten (it records what was originally asked), and a no-change
  edit is refused rather than logged as if something happened.
  Recipients, work descriptions, due dates, and triggers are not
  editable — changing who gets paid or what for is a new plan. The
  console's plan review renders the amount inputs and the Amend
  amounts action alongside Approve / Reject, only while pending.
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
- **Agent tool definitions (the tool-call-shaped action layer).**
  CONCEPT.md's stretch goal, built REST-first as planned: the agent's
  four operations are also published as tool definitions in MCP /
  PayPal Agent Toolkit shape — `{ name, description, inputSchema }`
  per tool, the names exactly the typed action types, each schema a
  closed object (`additionalProperties: false`) carrying the drafts'
  field rules (required fields, USD/EUR/GBP enum, amount > 0 and
  ≤ 100,000, ISO due-date pattern, payout batch of 1–25 lines).
  `GET /api/agent/tools` is the discovery surface; `POST
  /api/agent/tools` accepts one call (`{ name, arguments }`) or a
  sequence (`{ calls: […] }`, at most four) and *drafts* a typed
  action plan (`source: "tool"`, `pending_approval`) — conversion
  delegates field validation to the same resource drafts the REST
  wrappers use, so a tool step is payload-identical to the equivalent
  draft step, and unknown tool names or undeclared argument keys are
  rejected, never ignored. A payout call gates itself with
  `payWhenInvoicePaid` (one named invoice) or `gatedOnInvoicePaid`
  (this plan's own invoice payment, bound at execution) — never both.
  Nothing executes without the ordinary approve → execute flow: the
  approval gate has no tool-call back door either.
- **Next-action suggestions (the agent drafts its own follow-ups).**
  CONCEPT.md §3.1's data flow ends with the agent drafting the *next*
  action as a new pending plan — `POST /api/agent/suggest` (and the
  console's **Suggest next actions** button) is that step: it scans
  for overdue open invoices (the read model's definition, most
  overdue first) and drafts one `send_reminder` plan per uncovered
  invoice (`source: "suggested"`, `pending_approval`, its reference
  pinned to that invoice's number, the step identical to a
  hand-drafted reminder). An invoice whose reminder was already sent,
  or that a reminder plan in any status other than failed already
  targets, is reported under `skipped` with its reason — a rejected
  plan is not re-drafted, and nothing is ever sent without the
  ordinary approve → execute flow.
- **OpenAPI document (the machine-readable API map).** `GET
  /api/openapi` serves an OpenAPI 3.1 document covering every API
  operation in the app (29 paths, 31 operations): summaries, the
  approval-gate wording on every draft surface, the shared
  `{ error }` response shape, and the webhook event body. It is
  built from a registry in `src/lib/api/`, and the test suite walks
  the route files on disk and requires the document to describe
  exactly the operations they export — a route added without a
  document entry fails the suite. The document declares no host
  (a single relative server entry, the same no-invented-URL rule
  as the rest of the app), no credentials, and `security: []` on
  every operation: this API has no authentication layer, the
  approval gate is an application invariant rather than
  authentication, and a publicly exposed instance needs the
  deployer's own access controls (see SECURITY.md).
- **API documentation page (the human-readable API map).** The
  `/api-docs` page renders the same registry as a browsable page —
  every operation grouped by surface (Agent, Console, Health,
  Judge Mode, PayPal) with its summary, description, request-body
  note, and response codes, plus the no-authentication and
  approval-gate honesty notes and a link to the machine-readable
  document. There is exactly one list of operations in the
  codebase, so the human page and the OpenAPI document can never
  drift apart; the grouping is a pure view-model
  (`buildApiDocsSections`) that a test pins to cover every
  registered operation exactly once.
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
- **Invoice form (the §3.1 invoice surface).** The console ships a
  structured invoice form (above the Invoices grid): recipient (with an
  optional explicit email), description, amount, currency, and optional
  due date / note / reference, with inline validation mirroring the
  server's draft rules — including the real-calendar due-date rule
  (2026-02-30 is rejected, never rolled over) — a live preview, and an
  example invoice (the demo spine's Ana invoice). The form only ever
  drafts via `POST /api/paypal/invoices` — the invoice is created and
  sent through the same plan review → approve → execute gate as every
  other surface, and it then appears in the Invoices grid.
- **Sell form (the §3.1 “Sell something” flow).** The console ships a
  structured sell form (above the Orders grid): description, amount,
  currency, and an optional reference, with inline validation mirroring
  the server's draft rules, a live preview, and an example sale. The form
  only ever drafts via `POST /api/paypal/orders` — the order is created
  through the same plan review → approve → execute gate as every other
  surface, and its buyer checkout link then appears in the Orders grid's
  Buyer view.
- **Reminder form + draft wrapper (the fourth typed action).**
  `send_reminder` now has the same structured path as the other three
  actions: `POST /api/paypal/reminders` drafts a `pending_approval`
  plan whose step is payload-identical to the NL parser's reminder
  step, and the console ships a structured reminder form (above the
  Invoices grid): recipient (with an optional explicit email) and an
  optional invoice reference, with inline validation mirroring the
  server's draft rules, a live preview stating the targeting rule,
  and an example reminder (Marco's most-overdue open invoice — the
  Command bar's canonical example). The form only ever drafts — the
  reminder is sent through the same plan review → approve → execute
  gate, and the send then appears in the Activity audit grid.
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
- **Invoice record-payment leg (any open invoice, not just the spine).**
  An open invoice can be recorded as paid from inside the app — the
  Invoicing record-payment path (`POST /v2/invoicing/invoices/:id/payments`)
  that CONCEPT.md documents for payments made outside PayPal and for
  local runs. Until now only the Judge Mode spine invoice had an
  in-app payment path; the general leg lives in the Invoices grid
  (**Record payment** button, full amount due) and at
  `POST /api/paypal/invoices/record-payment` (an explicit amount
  records a partial payment — the invoice flips to `PARTIALLY_PAID`
  and no PAID event fires until the balance reaches zero). Amounts
  are validated before any call (positive, the invoice's own
  currency, never more than the amount due — an overpayment is
  refused, never clamped). A full payment is written to the audit
  log as the exact call and its `INVOICING.INVOICE.PAID` event is
  processed by the sync reconciler, so a trigger-gated payout bound
  to that invoice fires here exactly as it would on a webhook. It is
  deliberately *not* an agent action: recording money that already
  arrived needs no plan approval and does not weaken the gate.
  Re-recording a `PAID` invoice is an `alreadyPaid` no-op; an unknown
  invoice is a 404, a non-open one a 409, and an adapter refusal is
  audit-logged as a failed recording.
- **Sync reconciler.** `GET /api/paypal/sync` is the polling fallback for
  instances webhooks cannot reach: it drains undelivered events in order and
  sweeps resource state with stable synthetic event ids, so repeat syncs are
  no-ops. It never calls a mutating PayPal endpoint. The console's
  **Sync from PayPal** button runs it in place (the pure view-model in
  `src/lib/console/sync.ts` validates the route's wire shape before anything
  renders and summarises the outcome — a resumed plan is the headline, an
  idempotent re-run is reported honestly as "nothing new to reconcile") and
  then refreshes every grid, so reconciled state flips flash as usual.
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
- **Activity page (the §3.1 `/activity` surface).** The audit trail
  also has its own addressable page at `/activity`: the same
  ActivityRow read model from the same `GET /api/console/activity`
  route the console grid consumes — no second data path — rendered
  full-width with the console's own state and CSV-export view-models
  (loading / error / empty / filtered-empty, dated export file), the
  detail payload as an inspectable column, and 25 rows per page.
  It is read-only by construction (its only fetch is that one GET):
  actions stay in the console, so the page a judge deep-links to —
  or the video lingers on — can never approve, execute, or move
  money.
- **Invoices page (the §3.1 `/invoices` list surface).** The invoice
  list also has its own addressable page at `/invoices`: the same
  InvoiceRow read model from the same `GET /api/console/invoices`
  route the console grid consumes — no second data path — rendered
  full-width with the console's own state and CSV-export view-models,
  25 rows per page, and each invoice number linking to its detail
  page at `/invoices/[id]` (the status timeline fed by webhooks).
  It is read-only as a list (its only fetch is that one GET):
  creating invoices, recording payments, and approving plans stay
  in the console.
- **Checkout page (the §3.1 `/checkout` surface).** The sell side
  also has its own addressable page at `/checkout`: the same
  OrderRow read model from the same `GET /api/console/orders`
  route the console grid consumes — no second data path — rendered
  full-width with the console's own state and CSV-export view-models,
  25 rows per page, and the Buyer view column showing each payable
  order's checkout link (mock links labeled as mock). It is
  read-only as a list (its only fetch is that one GET): creating
  orders through the Sell form and capturing stay in the console.
- **Payouts page (the §3.1 `/payouts` list surface).** The payouts
  list also has its own addressable page at `/payouts`: the same
  PayoutRow read model from the same `GET /api/console/payouts`
  route the console grid consumes — no second data path — rendered
  full-width with the console's own state and CSV-export view-models,
  25 rows per page, one row per payout item with its batch context
  flattened in. It is read-only as a list (its only fetch is that
  one GET): drafting batches in the payout batch builder and
  releasing them through the approval gate stay in the console.
- **Command page (the §3.1 `/command` surface).** The Agent Command
  bar also has its own addressable page at `/command`: the console's
  own CommandBar component rendered standalone — no second command
  implementation — so a brief can be drafted, reviewed as a checklist
  with the exact PayPal calls and trigger-gated steps marked, and
  approved / rejected / executed from its own route. Unlike the
  standalone list pages it is not read-only: plan review *is* the
  approval gate, and it drives only the `/api/agent/*` routes — it
  never calls PayPal directly, and the server-side gate remains the
  enforcement point. Plans drafted here are the console's plans; the
  pending-decision queue is shared.
- **Disputes page (the read-only Disputes surface, standalone).** The
  disputes list also has its own addressable page at `/disputes`: the
  same DisputeRow read model from the same `GET /api/console/disputes`
  route the console grid consumes — no second data path — rendered
  full-width with the console's own state and CSV-export view-models,
  25 rows per page, response deadlines with overdue highlighting, and
  seeded rows flagged "Sample". The Evidence draft is carried over
  because it belongs to this read-only surface: it loads the same
  draft-only evidence summary (`GET /api/console/disputes/[id]/evidence`)
  for seller review and never submits anything — the Disputes
  integration is read-only end to end, so the page's only fetches are
  those two GETs and nothing here approves, executes, or moves money.
- **Reconciliation page (the read-only Transaction Search surface, standalone).**
  The reconciliation ledger also has its own addressable page at
  `/transactions`: the same TransactionRow read model from the same
  `GET /api/console/transactions` route the console grid consumes — no
  second data path — rendered full-width with the console's own state
  and CSV-export view-models, 25 rows per page, signed amounts
  (payments in positive, payouts out negative in red). It is read-only
  end to end (its only fetch is that one GET): Transaction Search never
  moves money, and this page is the ledger the KPI totals reconcile
  against. With this page, every console grid has a standalone route.
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
- **PayPal mode indicator.** The console's mode strip (above the KPI
  strip) states the instance's *actual* PayPal mode on screen — Mock,
  Sandbox, Sandbox without a webhook id (the sync reconciler named as
  the fallback), or Sandbox misconfigured (the missing credential
  variables named as the remedy) — resolved from `GET /api/health` by
  the pure view-model in `src/lib/console/mode.ts`, which validates
  the report's wire shape, keeps only whitelisted fields (mode,
  status, configuration booleans), and builds the badge copy from
  those booleans, so no report free text — and no credential value —
  can reach the screen through it. An unreadable report resolves to
  "unknown", never a guessed mode. A judge watching a loop close can
  therefore tell from the screen whether it closed against the mock
  adapter or the live sandbox.
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
- **Structured API errors.** The deployment-readiness case above no longer
  ends in an opaque framework 500 anywhere else: every runtime-backed API
  route acquires its runtime through `acquireRuntime`
  (`src/lib/api/errors.ts`), which translates the sandbox-not-configured
  failure into a structured 503 in the API's one shared error shape
  (`{ error }`, naming the missing variables and the mock-mode
  alternative — never a credential value). Any other failure is rethrown
  untouched, not dressed up. The OpenAPI document and the `/api-docs`
  page carry the same shared 503 on every runtime-backed operation via
  `apiOperationResponses`; the only operations without it are the three
  that never build the runtime (`GET /api/health`, `GET /api/openapi`,
  and the tool definitions' `GET /api/agent/tools`).
- **Unknown API routes (the JSON 404).** A path under `/api/` that no
  route implements is answered by an optional catch-all route
  (`src/app/api/[[...slug]]/route.ts`, delegating to
  `src/lib/api/unknown-route.ts`) with a JSON 404 in the same shared
  `{ error }` shape — naming the requested path and pointing at
  `GET /api/openapi` — for every method, instead of the page-level
  HTML not-found an API consumer cannot parse. The catch-all builds
  no runtime, so unknown paths answer 404 even on a misconfigured
  instance whose implemented routes answer 503; concrete routes
  always take precedence, and the catch-all is deliberately not a
  documented OpenAPI operation.
- **Container deployment.** A `Dockerfile` (repo root) packages the same
  hosted demo for any container host: every stage pins Node 22, the
  image installs with `npm ci`, builds with `npm run build`, and starts
  with `npm start` as the non-root `node` user, in production mode and
  the default mock mode, health-checked at `GET /api/health`. No
  credential value is ever baked into the image — sandbox mode is a
  runtime `-e` decision with your own variables. `.dockerignore` keeps
  local state, snapshots, and `.env` files out of the build context.
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
- **Web app manifest + share metadata.** `src/app/manifest.ts` serves
  `/manifest.webmanifest` with the app's identity — name, description,
  `start_url: "/"`, the existing app icon, and theme/background colours
  taken from the app itself (`#111827` icon/ink, `#ffffff` page) — and
  the root layout carries matching Open Graph / Twitter share fields
  plus a `themeColor` viewport. It is identity metadata only:
  LedgerPilot ships no service worker and no offline mode, and the
  manifest claims neither. No `metadataBase`, canonical, or openGraph
  URL is declared, for the same reason robots declares no sitemap —
  no public URL exists to declare before hosting, and none is invented.
- **Generated share image.** `src/app/opengraph-image.tsx` (re-exported
  by `twitter-image.tsx`) generates the 1200×630 PNG share card with
  `next/og` — the app's name and one-liner over its own colours and the
  icon's ledger-rows motif — and the file conventions reference it in
  the Open Graph / Twitter tags automatically (the Twitter card is
  `summary_large_image`). It replaces a hand-declared share image that
  pointed at the square SVG icon, which share crawlers do not render.
  No external asset, font, or URL is fetched: the image renders
  identically offline, locally, and on the hosted demo.
- **Apple touch icon.** `src/app/apple-icon.tsx` generates the
  180×180 PNG touch icon with `next/og` — the app icon's ledger-rows
  motif in its own colours (`#111827` / `#ffffff` / `#22c55e`) — and
  the file convention references it automatically as the
  apple-touch-icon. iOS / Safari do not use the SVG favicon or the
  manifest's SVG icon for the touch surface, so without it the
  hosted demo would have had no touch icon on Apple devices. The
  background is full-bleed (Apple masks and rounds the corners
  itself), and no external asset, font, or URL is fetched.
- **Legacy ICO favicon.** `src/app/favicon.ico` serves the surface
  browsers and tooling still request directly at `/favicon.ico`,
  which 404'd while only the modern conventions existed. Its three
  entries (16 / 32 / 48 px, classic 32-bpp BMP) redraw the app icon's
  own motif — ink square, white ledger rows at the SVG's opacities,
  green status dot — and are generated deterministically by
  `scripts/generate-favicon.py` (pure Python standard library, no
  Pillow, no network; re-run it if `icon.svg` changes). Because the
  entries are uncompressed, the test suite asserts the rendered
  pixels themselves — transparency outside the rounded square, the
  0.65-opacity row composited over the ink, the dot — not just the
  file's presence.
- **Accessibility shell.** The root layout's first focusable element is
  a "Skip to main content" link that stays off-viewport until focused,
  then pins to the top-left and jumps to the page's single
  `<main id="main-content" tabIndex={-1}>` landmark (present on the
  console, Judge Mode, invoice detail, and the 404 / error / loading
  surfaces). Keyboard focus is always visible — a global
  `:focus-visible` outline, and no rule in `globals.css` removes an
  outline without replacing it — and a `prefers-reduced-motion` media
  query collapses animations, transitions, and smooth scrolling for
  visitors who ask for less motion. (The global-error fallback replaces
  the root layout itself, so it carries neither the skip link nor
  `globals.css` — the same documented limit as its styling.)
- **Page metadata.** Every addressable page carries its own typed
  `Metadata` export with a distinct title and description — the
  Operations Console (this page), Judge Mode, invoice detail, and the
  404 surface — so browser tabs, bookmarks, and link shares name the
  surface a judge is actually on instead of the bare app name the
  console previously inherited from the root layout. No page declares
  a URL, canonical, or `metadataBase`: no public host exists before
  the hosted deployment, and none is invented (the same rule the root
  layout and `robots` follow).
- **Site navigation.** The root layout renders a primary nav (from
  `src/lib/nav/site-nav.ts`, the single source of truth) on every
  page, so every addressable surface — Console, Command, Invoices,
  Checkout, Payouts, Disputes, Reconciliation, Activity, Judge Mode,
  API docs — is reachable from every other page, not only via the
  console home's prose links or a page's back-link. The current
  page's link carries `aria-current="page"` (an invoice detail page
  keeps the Invoices link current). The test suite walks `src/app`
  for the page routes on disk and requires the nav list to match
  them exactly, so a new page cannot ship unnavigable and a removed
  page cannot leave a dead link; dynamic detail routes are
  deliberately not primary-nav destinations, and no external URL is
  listed.
- **Repository text hygiene.** `.editorconfig` declares the tree's
  text conventions where editors read them (UTF-8, LF line endings,
  a final newline, no trailing whitespace, space indentation — 2 in
  general, 4 for Python; Markdown exempt from the trim rule because
  trailing double-spaces are a hard break), and `.gitattributes`
  declares the same LF rule to Git (`* text=auto eol=lf`), so a
  clone made with `core.autocrlf` cannot hand back whole-file CRLF
  diffs. The attributes also mark `*.ico` / `*.png` binary —
  concretely protecting the committed `favicon.ico`, whose suite
  asserts exact bytes and rendered pixels, from any line-ending
  conversion pass. The test suite keeps the two files in agreement
  and checks the tree's text files against the rules themselves.
- **Verification script.** `npm run verify` runs the whole
  verification gate — `npm run typecheck && npm test && npm run build`,
  in the order CI runs them — as one command, so a contributor or
  the publish-day gate never has to retype the sequence (or risk
  running it out of order). It installs nothing, starts no server,
  and reads no credentials; its exact command string is pinned by
  tests against the CI workflow's step order, so the shortcut
  cannot drift from the gate it abbreviates.

## Run it locally

Node 22 is the pinned runtime (`.nvmrc` + the `package.json` `engines`
floor; CI and the Render blueprint pin the same major — newer majors
are not blocked, the suite also runs on them).

### Mock mode (default — no credentials, no keys)

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # full test suite (700 tests)
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

Once your sandbox app exists, `npm run smoke:sandbox` (see Testing)
verifies this mode end to end against a running sandbox instance —
it refuses a mock-mode or misconfigured target before drafting
anything, then runs the invoice → record-payment, payout, and order
legs through the approval gate with fictional verification amounts.

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
variables. Once a hosted instance is up, verify it end to end with
`SMOKE_BASE_URL=<hosted demo URL> npm run smoke` (see Testing) — the
script runs the full Judge Mode loop against the live instance and
asserts the README totals.

For any container host, the `Dockerfile` (repo root) packages the
same demo: `docker build -t ledgerpilot .` then
`docker run --rm -p 3000:3000 ledgerpilot` serves it on port 3000 in
the default mock mode (Judge Mode included), as the non-root `node`
user, with a container health check probing `GET /api/health`. No
credential value is baked into the image; to run your own sandbox
app instead, pass the same variables from `.env.example` at run time
(`docker run -e PAYPAL_MODE=sandbox -e PAYPAL_CLIENT_ID=... ...`).
`.dockerignore` keeps `.env` files, local snapshots, and build
output out of the build context.

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
- `src/lib/agent/tools.ts` — the agent tool definitions: the four
  typed actions as MCP / Agent Toolkit-shaped tools (name, description,
  closed JSON input schemas), the tool-call envelope validator
  (unknown tools / undeclared arguments rejected), and conversion of
  one or more calls into a `source: "tool"` plan — delegating field
  validation to the resource drafts so tool steps are identical to
  draft steps, with both payout-gating forms supported.
- `src/lib/agent/edit.ts` — plan amendment: `stepAmounts` extraction
  for every step shape and `editPlanAmounts` — pending-approval-only
  amount edits validated through the drafts' `parseMoney`, with step
  descriptions regenerated in the builders' formats and the change
  written to the audit log (the brief is never rewritten).
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
  the console banner, and KPI/caption rules), the grid-tools
  view-model (`grid-tools.ts`: CSV export naming/gating + change-flash
  detection), the sync view-model (`sync.ts`: wire-shape validation
  + outcome summary for the console's Sync from PayPal action), and
  the mode view-model (`mode.ts`: health-report wire validation +
  the PayPal mode badge — mock / sandbox / degraded / misconfigured /
  unknown — rendered as the console's mode strip).
- `src/lib/nav/` — site navigation: the primary nav's link list
  (single source of truth, pinned by tests against the page routes
  on disk) and the active-link resolution the layout's nav renders.
- `src/lib/command/` — Agent Command bar view-model: brief validation,
  example briefs, the plan-review model (step labels, exact PayPal call,
  trigger badges, editable amounts per step), the amount-amendment
  collector (changed amounts only, formatted for `POST /api/agent/edit`),
  and action-availability rules that mirror the server-side
  approval gate.
- `src/lib/batch/` — payout batch builder view-model: form-line
  editing guards (1–25 lines), the per-line validation mirror of the
  server rules, request-body building, and the live per-currency
  totals preview for the console's batch form.
- `src/lib/invoice/` — invoice-form view-model: validation mirror of
  the invoice draft rules (incl. the real-calendar due-date rule),
  request-body building, and the live preview for the console's
  invoice form; plus the record-payment leg (`record-payment.ts`:
  full/partial payment recording for any open invoice — amount
  validation, audit record, the PAID event processed via the
  reconciler, idempotent re-recording).
- `src/lib/reminder/` — reminder-form view-model: validation mirror
  of the reminder draft rules, request-body building (empty optionals
  omitted), and the live preview stating the targeting rule for the
  console's reminder form.
- `src/lib/ask/` — Ask-the-grid parser + filter-model validator.
- `src/lib/checkout/` — the Orders checkout leg: the buyer-view
  resolution (`checkout-link.ts`: approval-link extraction —
  `approve` before `payer-action`, mock links flagged — plus the
  payable / captured / voided / unavailable view states projected
  into the Orders grid rows), the capture leg (buyer-side checkout
  completion for a created order: status guards, audit record, capture
  event processed via the reconciler, idempotent re-capture), and the
  sell-form view-model (`order-form.ts`: validation mirror of the
  order draft rules, request-body building, live preview).
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
- `src/lib/api/` — the OpenAPI registry + document builder behind
  `GET /api/openapi`: one registry entry per API operation, the
  shared Error schema, relative-only server entry, and
  `security: []` throughout (no auth layer exists to declare);
  completeness against the route files is test-enforced. The same
  module's documentation sections (`buildApiDocsSections`) group
  the registry by tag for the human-readable `/api-docs` page, and
  its error translation (`errors.ts`: `acquireRuntime` +
  `paypalNotConfiguredResponse`) is the one place every
  runtime-backed route acquires the runtime, so the
  sandbox-not-configured case answers the structured 503 above
  instead of an opaque 500; `apiOperationResponses` appends that
  same 503 to every runtime-backed operation in both surfaces.
  Its unknown-route module (`unknown-route.ts`) backs the
  `/api/` catch-all route: paths no route implements answer the
  JSON 404 in the same shared shape, without building a runtime.
- API routes — `GET /api/health` (readiness; 200 ok/degraded, 503
  misconfigured), `GET /api/openapi` (the OpenAPI 3.1 document), `src/app/api/agent/` (`POST /plan`, `POST /approve`,
  `POST /execute`, `POST /edit` — amend a pending plan's amounts,
  `GET|POST /tools` — tool definitions + tool-call
  plan drafting), `src/app/api/paypal/` (`POST /invoices|orders|payouts|reminders` —
  validated wrappers that draft plans, never execute; `POST /webhooks` — 401 on bad
  signature, 200 on processed/duplicate; `GET /sync`; `POST /orders/capture`;
  `POST /invoices/record-payment`),
  `src/app/api/console/` (`GET /invoices|orders|payouts|activity|disputes|transactions|summary`,
  plus `GET /invoices/[id]` for the detail projection and
  `GET /disputes/[id]/evidence` for the draft-only evidence summary),
  `src/app/api/judge/` (`GET /`, `POST /seed`, `POST /pay`, `POST /reset`).
- UI — `src/app/` (operations console at `/`, Judge Mode at `/judge`,
  invoice list at `/invoices`, invoice detail at `/invoices/[id]`,
  checkout orders at `/checkout`, payouts at `/payouts`,
  agent command / plan review at `/command`,
  disputes (read-only, with the draft-only evidence summary) at `/disputes`,
  reconciliation — the signed Transaction Search ledger (read-only) at
  `/transactions`,
  agent activity & webhook audit at `/activity`, API documentation —
  the human-readable rendering of the OpenAPI registry — at
  `/api-docs`).

## PayPal APIs used

| API | How LedgerPilot uses it |
|---|---|
| **Invoicing v2** | Create/send invoices from briefs; get/list; record-payment for any open invoice (console Record payment action / `POST /api/paypal/invoices/record-payment`, full or partial); send payment reminders (`POST /v2/invoicing/invoices/:id/remind`) for open invoices |
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
npm test           # vitest — 700 tests, all green
npm run typecheck  # TypeScript strict, clean
npm run build      # Next.js production build
npm run verify     # the whole gate below, as one command
```

The same sequence runs in CI (`.github/workflows/ci.yml`) on every
push to `main` and every pull request — no secrets required, since
the suite is fully offline and the build runs in mock mode.
`npm run verify` is the single-command form of the gate
(`npm run typecheck && npm test && npm run build`, in CI's order);
it installs nothing and starts no server — run `npm ci` (or
`npm install`) first on a fresh clone, exactly as CI does.

The suite covers: the mock PayPal surface (invoice lifecycle, partial
payments, capture/payout guards, the full invoice→paid→payout loop),
the checkout buyer view (approve-link extraction with payer-action
fallback, mock links flagged, captured orders never re-offered a pay
link, voided / link-less states honest, order-row projection through
a real mock create → capture loop),
the checkout capture leg (an agent-created order captured to COMPLETED
with the capture event processed once, re-capture no-op, unknown /
VOIDED / adapter-refusal paths audit-logged),
the invoice record-payment leg (a spine invoice recorded paid closing
the full loop with its gated payout, a partial payment flipping to
PARTIALLY_PAID with no event until the remainder lands, a seeded
non-spine invoice paid through the same path, already-paid no-op,
unknown / DRAFT / invalid-amount refusals before any adapter call,
and an adapter refusal audit-logged as a failure),
the sell form view-model (validation mirror naming the failing field,
request-body normalisation, a preview that never guesses an invalid
amount, and a form-built draft — example included — accepted by the
real order draft, refused unapproved, then executed into a payable
order that captures),
the invoice form view-model (validation mirror naming the failing
field incl. the real-calendar due-date rule, request-body
normalisation with empty optionals omitted, a preview that never
guesses an invalid amount, and a form-built draft — example
included — accepted by the real invoice draft, refused unapproved,
then executed into a SENT invoice with its due date),
the reminder draft + form (the draft's step is payload-identical to
the parser's reminder step with and without a reference, a 400
validation matrix naming the field, the form's validation mirror /
request body / targeting-rule preview, and form-built drafts —
example included — refused unapproved, then executed through the
gate to remind Marco about Judge Mode's seeded overdue invoice and
to send by explicit invoice number, with an unmatched reference
failing the plan),
invoice reminders (mock open-invoice rules, executor resolution by
reference and by most-overdue open invoice, unmatched-reference and
already-paid failures, the sandbox `/remind` request shape), the
agent pipeline (brief parsing incl. due-date forms and currencies, the
approval gate, trigger resume, audit ordering), site navigation (the
nav list matching the page routes on disk exactly, dynamic detail
routes excluded, active-link resolution — root exact, sections by
prefix — and the layout rendering the nav after the skip link),
webhooks + reconciler
(bad-signature rejection, duplicate delivery, webhook/reconciler
non-interference, resource-correlated trigger resumption), console read
models (per-currency totals, overdue flags, dispute response deadlines +
sample flags, signed reconciliation ledger), dispute-evidence summaries (reason labels, exact-id transaction matching, buyer+amount invoice matching, overdue/due-soon urgency, delivery proof always a gap, unknown-id 404), console states (loading /
error / empty / filtered-empty precedence, overlay HTML escaping, banner
and KPI rules), console grid tools (dated CSV export
file names + export gating, change-flash detection — a SENT→PAID flip
flashes, new rows never do, append-only grids watch nothing), the
console sync view-model (wire-shape validation with field-named
rejections, resumed-plan / new-event / nothing-new outcome summaries,
and a real reconciler run over the demo spine whose route-shaped
result parses and names the resumed plan), the console mode
view-model (health-report wire validation keeping only whitelisted
fields, mock / sandbox / degraded / misconfigured / unknown badge
resolution, a sentinel secret in the payload never surviving parsing
or rendering, and end-to-end badges resolved from the real health
report for mock, misconfigured-sandbox, and configured-sandbox
environments), the standalone
activity page (typed page metadata + skip target, the same
activity route and read model as the console grid, the console
state/export view-models reused, no mutating endpoint called,
the home page linking to it, and its rows projected from a real
executed loop), the standalone invoices page (typed page metadata
+ skip target, the same invoices route and read model as the
console grid, the console state/export view-models reused, a
detail link per invoice row, no mutating endpoint called, the
home page linking to it, and its rows projected from a real
executed loop), the standalone checkout page (typed page metadata
+ skip target, the same orders route and read model as the
console grid, the console state/export view-models reused, the
buyer view per order row with no capture action and no mutating
endpoint called, the home page linking to it, and its rows
projected from a real executed sell loop), the standalone
payouts page (typed page metadata + skip target, the same
payouts route and read model as the console grid, the console
state/export view-models reused, no batch-builder form or
release action and no mutating endpoint called, the home page
linking to it, and its rows projected from a real executed
payout loop), the standalone command page (typed page metadata
+ skip target, the console's own CommandBar rendered standalone
with no second implementation and no direct PayPal call, the
home page linking to it, and the demo spine's review listing its
exact calls with the payout trigger-gated, executing nothing
until approved), the standalone disputes page (typed page metadata
+ skip target, the same disputes route and read model as the
console grid, the console state/export view-models reused, the
evidence draft carried over as a GET-only never-submitted draft
with no mutating endpoint called, the home page linking to it,
and its rows projected from the mock dispute set with the sample
flag and deadline intact), the standalone reconciliation page
(typed page metadata + skip target, the same transactions route
and read model as the console grid, the console state/export
view-models reused, no mutating endpoint called, the home page
linking to it, and its rows projected as the signed ledger of a
real invoice→payout loop), the
command-bar gate matrix, plan amendment (amount extraction for
every step shape, pending-only editing with regenerated descriptions
and an audit record, the 404/409/400 refusal matrix including a
no-change edit, and a full loop executed at the amended amounts),
Ask-the-grid parsing +
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
the validation rejection matrix), the agent tool definitions
(the four closed input schemas agreeing with the validator's accepted
arguments, steps identical to the resource drafts for every action —
batch payouts and both gating forms included — unknown-tool and
undeclared-argument rejection, the four-call plan cap, and a
tool-sourced plan closing the full invoice → paid → payout loop
through the gate), the OpenAPI document (the registry-built
document describing exactly the operations the route files on disk
export — walked and compared in the suite — relative server only,
no credential or email anywhere, the shared Error schema referenced
by every error response, path parameters declared, request bodies
present exactly where a route takes one, and the gate wording on
every draft surface), the API documentation page (sections built
from the same registry in tag order, every registered operation
rendered exactly once, an operation-less tag omitted, and the page
itself carrying no hardcoded API path, no fetch, and no external
URL), payout batches (per-line validated
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
`@types/node` tracking it, CONTRIBUTING.md stating it, and every
Dockerfile stage pinning it — a version
bump must move all six sites at once), and the code of conduct
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
robots function's return value is asserted directly), and the web
app manifest + share metadata (the manifest function's return value
asserted directly — identity fields, colours matching the icon and
globals.css, the icon pointing at the real file-convention icon,
no external URL — the layout's Open Graph / Twitter fields and
viewport theme colour agreeing with the manifest, and no invented
metadataBase / canonical / public URL anywhere), and the generated
share image (the opengraph-image constants — 1200×630 PNG, alt text —
pinned, the app's own colours asserted against the icon, no external
URL or fetch in the source, the rendered PNG's signature and IHDR
dimensions verified, the twitter-image re-export, and the layout
leaving share images to the conventions with a `summary_large_image`
card), and the accessibility shell (the skip link rendered before the
page content in the root layout, every layout-rendered page carrying
exactly one `<main id="main-content" tabIndex={-1}>` skip target, the
skip link hidden until focused, the global `:focus-visible` outline
with no outline-removal rule anywhere in `globals.css`, and the
`prefers-reduced-motion` collapse of animations / transitions /
smooth scrolling), and the page metadata (every addressable page —
console, Judge Mode, invoice detail, the 404 surface — carrying a
typed `Metadata` export with a distinct `LedgerPilot — …` title and
a substantive, distinct description, the console description naming
its surfaces and the sandbox / mock-only rule and differing from the
layout's generic description, and no URL / canonical / `metadataBase`
/ credential / email declared in any page's metadata), and the
Apple touch icon (the apple-icon constants — 180×180 PNG — pinned,
the app icon's own colours asserted against `icon.svg`, the
full-bleed root with no border radius of its own, no external URL
or fetch in the source, the rendered PNG's signature and IHDR
dimensions verified, and the layout leaving the touch icon to the
convention), and the legacy ICO favicon (`src/app/favicon.ico` —
the ICONDIR header and the 16 / 32 / 48 entries parsed, each a
32-bpp BMP of the declared size, the rendered pixels asserted
(transparent corners outside the rounded square, the ink
background, the full-opacity row, the 0.65-opacity row composited
over the ink, the green status dot, the motif still rendering at
16 px), the committed stdlib-only generator script redrawn from
the `icon.svg` motif, and the layout leaving the favicon to the
convention), and the publish-day smoke script (`scripts/smoke.mjs` —
the documented endpoints driven in loop order, the reset-before-seed
re-runnability with its disposable-instance warning, the approval
gate passed through rather than shortcut, the README's exact
post-loop totals asserted per currency, no credential read and no
import beyond Node's fetch, and the named-step failure with exit
code 1), and the sandbox verification smoke script
(`scripts/smoke-sandbox.mjs` — the sandbox-mode gate on
`GET /api/health` before any draft, a misconfigured instance
stopped at that step, the invoice / payout / order legs driven in
order through the approval gate with no Judge Mode reset or seed,
the fictional verification amounts and counterparty, the payout
acceptance statuses, the real-https buyer-link check with capture
deliberately not attempted, no credential read and no import
beyond Node's fetch, and the named-step failure with exit code 1),
and the CodeQL workflow (`.github/workflows/codeql.yml` —
push / pull-request / weekly-schedule triggers on main+master, the
javascript-typescript matrix with `build-mode: none` so scanning
never runs project scripts, init before analyze in the pinned
official actions, permissions limited to contents read +
security-events write, and no secrets anywhere), and the package
license metadata (the root `LICENSE` file's MIT heading and
copyright, the `package.json` SPDX `license: "MIT"` field, and the
`package-lock.json` root entry agreeing — a metadata change that
does not re-sync the lockfile fails here — with the README License
section linking the file and the package staying `private: true`),
and the support file (`SUPPORT.md` — best-effort with no SLA and no
invented contact channel, self-diagnosis via the health check and
Judge Mode first, bugs and features routed to the issue forms,
vulnerabilities and conduct routed privately and never to a public
issue, and the scope limits — no PayPal account access, no
real-money mode, latest default branch only), and the repository
text hygiene (`.editorconfig` root + global conventions, the
Markdown trim exception and the Python indent, `.gitattributes`
storing text as LF and marking the icon assets binary, the two
files agreeing on LF, and the tree's text files themselves
carrying no CR endings, ending with a final newline, and carrying
no trailing whitespace outside Markdown and no tab indentation),
and the code owners file (`.github/CODEOWNERS` — the solo owner's
default rule covering the whole tree, the security- and
automation-sensitive surfaces — workflows, Dependabot config,
`SECURITY.md`, the deployment descriptor, the file itself —
explicitly owned, every rule naming the same one owner, the
last-match-wins rule documented, and no email address or
credential-shaped value published), and the container descriptor
(`Dockerfile` — every stage pinning Node 22, install / build / start
via the package's own scripts, mock mode as the credential-free
default with no secret value baked in, production mode on port 3000
bound to all interfaces, the non-root `node` user set before the
start command, and a health check probing the real `/api/health`
route — plus `.dockerignore` keeping `.env` files, local snapshots,
dependencies, and build output out of the context while never
excluding the sources or manifests the build needs), and the
verification script (`npm run verify` — the exact gate command
string, its step order agreeing with the CI workflow's, no
install / server / smoke / credential anywhere in it, and every
script it references existing in `package.json`)
— fake credentials only, no network.

### Smoke check (a running instance, end to end)

```bash
npm start                            # in one terminal (mock mode)
npm run smoke                        # in another — http://127.0.0.1:3000
npm run smoke -- --base-url http://127.0.0.1:3100
SMOKE_BASE_URL=<hosted demo URL> npm run smoke
```

`scripts/smoke.mjs` (zero dependencies, Node ≥ 22) drives one full
Judge Mode loop over HTTP — health, reset, seed, approve, execute,
pay, summary — and asserts the exact end state promised above
(collected USD 570.00 / EUR 100.00, outstanding EUR 200.00 /
USD 280.00, captured orders USD 59.00, payouts sent USD 280.00).
It resets the target first so it can be re-run, which is also its
safety rule: **only ever point it at a disposable mock-mode demo
instance** — never at sandbox mode (the reset refuses there and
the script stops) and never at an instance holding data you care
about. It reads no credentials; the only environment variable it
consults is `SMOKE_BASE_URL`.

### Sandbox verification (a running sandbox instance, end to end)

```bash
PAYPAL_MODE=sandbox PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm start   # one terminal, your own sandbox app
npm run smoke:sandbox                        # in another — http://127.0.0.1:3000
npm run smoke:sandbox -- --base-url http://127.0.0.1:3100
```

`scripts/smoke-sandbox.mjs` (zero dependencies, Node ≥ 22) is the
automated form of the sandbox exit test. It first reads
`GET /api/health` and **refuses to draft anything** unless the
target is in sandbox mode with credentials configured — a
mock-mode target fails that step (use `npm run smoke` there), and
a misconfigured sandbox stops there too, naming the missing
variables. It then drives the instance's own API surfaces through
the approval gate — an invoice drafted, approved, executed
(created + SENT) and recorded PAID; a payout batch drafted,
approved, and executed (an item status of SUCCESS, UNCLAIMED, or
PENDING counts as PayPal acceptance; a refusal, e.g. Payouts not
enabled on the sandbox Business account, fails the step with
PayPal's error verbatim); an order drafted, approved, and executed
with its buyer checkout link verified as a real PayPal URL
(capture is deliberately not attempted — sandbox capture needs the
buyer's approval on the hosted checkout, a browser step) — and
finishes with the sync reconciler. Amounts are fictional
verification amounts (USD 10.00 / 2.00 / 5.00) to a fictional
"Sandbox Check" counterparty; all money is sandbox money. The
script reads no credentials (credentials live in the target
instance's own environment); the only environment variable it
consults is `SMOKE_BASE_URL`. There is no reset in sandbox mode,
so each run creates fresh sandbox resources and prints their ids.

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
review, nothing auto-merges. The shipped code is also scanned by a
CodeQL workflow (`.github/workflows/codeql.yml`) on every push and
pull request and weekly, reporting to GitHub code scanning; it runs
with no secrets and writes nothing but scanning results.

## Support

See [SUPPORT.md](./SUPPORT.md): best-effort support through GitHub
only — self-diagnose with `GET /api/health` and Judge Mode first,
bugs and feature requests through the issue forms, and never a
public issue for a vulnerability or a conduct concern.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md): the verification gate
(typecheck → test → build, exactly what CI runs), the invariants a
change must not break (approval gate, deterministic-first AI,
verified webhooks, per-currency money, labeled sample data), and
how to report bugs through the issue templates. Review routing
lives in [`.github/CODEOWNERS`](./.github/CODEOWNERS): LedgerPilot
is a solo project, so the project owner owns the whole tree, with
the security- and automation-sensitive surfaces named explicitly.
Security flaws
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

MIT — see [LICENSE](./LICENSE). The same license is declared in
the `package.json` metadata as the SPDX identifier `MIT` (mirrored
in `package-lock.json`), so package tooling reads the same license
as the repository file; the package itself stays `private: true`
— LedgerPilot is an app, not a published library.
