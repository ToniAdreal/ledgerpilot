# LedgerPilot

An AI money operator for solo sellers and freelancers. You say what happened in plain English — LedgerPilot drafts, sends, tracks, and reconciles the money through PayPal. Every action is proposed first and executed only on approval, and every step is written to an auditable operations console.

> PayPal AI Hackathon entry (sandbox only — no real money moves anywhere in this project).

## Status

Core loop complete: the deterministic agent pipeline is live — a plain-English brief becomes a typed action plan, nothing executes without approval, and a payout gated on invoice payment stays deferred until the payment lands. Verified, idempotent webhooks (`POST /api/paypal/webhooks`) resume gated steps, and a polling sync reconciler (`GET /api/paypal/sync`) closes the same loop when webhooks cannot reach the instance. The operations console is live at `/`: KPI strip (outstanding, collected to date, pending approvals, awaiting trigger, open disputes, captured orders, payouts sent) plus four AG Grid surfaces — Invoices, Orders / Checkout, Payouts, and Agent Activity & Webhook Audit — fed by `GET /api/console/*` read models. The **Agent Command bar** is live at the top of the console: write a brief, review the typed plan (every step shows its exact PayPal call; trigger-gated steps are marked), approve or reject it, and execute — the grids refresh when execution settles, and plans still waiting for a decision are listed so a page reload never loses pending work. Ask-the-grid and Judge Mode seeding land in the remaining full-loop chunks.

Try it in the console at `/`, or against the running dev server:

```bash
curl -X POST localhost:3000/api/agent/plan -H 'content-type: application/json' \
  -d '{"brief":"Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco."}'
# → 201: a pending_approval plan with the exact PayPal calls listed
curl -X POST localhost:3000/api/agent/approve -H 'content-type: application/json' -d '{"planId":"plan-0001","decision":"approve"}'
curl -X POST localhost:3000/api/agent/execute -H 'content-type: application/json' -d '{"planId":"plan-0001"}'
# → invoice SENT now; payout deferred (awaiting_trigger) until INVOICING.INVOICE.PAID
```

## Run it (mock mode — no credentials, no keys)

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # adapter test suite
npm run typecheck
```

Mock mode (`PAYPAL_MODE=mock`, the default) implements the full PayPal surface used by LedgerPilot — Invoicing v2, Orders v2, Payouts, webhook signature verification, Disputes and Transaction Search (read-only) — against in-memory fixtures, so the whole loop runs with zero setup.

## Architecture

- `src/lib/types.ts` — domain types mirroring the PayPal REST resources, plus the typed agent action plan (`create_invoice` / `create_order` / `draft_payout` / `send_reminder`).
- `src/lib/paypal/client.ts` — the `PayPalClient` adapter contract; app code never calls PayPal directly.
- `src/lib/paypal/mock.ts` — mock adapter (October default).
- `src/lib/paypal/sandbox.ts` — sandbox adapter boundary: validates the caller's own sandbox credentials from env; REST wiring lands with the sandbox milestone.
- `src/lib/agent/parser.ts` — deterministic NL brief → typed action plan parser (no LLM, no keys; relative due dates resolved against an injectable reference date).
- `src/lib/agent/store.ts` — in-memory ledger: plans, the append-only activity/audit log, and webhook event-id idempotency.
- `src/lib/agent/executor.ts` — the only path from an approved plan to PayPal calls; trigger-gated steps are deferred and resumed by `resumeTriggeredSteps` when the matching event arrives.
- `src/lib/agent/webhooks.ts` — webhook handling: signature verification through the adapter, event-id idempotency, audit logging, and trigger resume. Unverified events are rejected and never marked processed.
- `src/lib/agent/reconciler.ts` — polling fallback (`syncFromPayPal`): drains undelivered emitted events and sweeps resource state with stable synthetic event ids, so repeat syncs are no-ops.
- `src/app/api/agent/` — `POST /plan` (brief → plan), `POST /approve` (the approval gate), `POST /execute` (approved plans only).
- `src/app/api/paypal/` — `POST /webhooks` (401 on bad signature, 200 on processed/duplicate), `GET /sync` (idempotent reconciler).
- `src/lib/console/` — console read models: pure projections (invoice rows with overdue flags, order rows with capture state, payout rows flattened one-per-item with batch context, activity/audit rows, per-currency KPI totals — money is never summed across currencies).
- `src/app/api/console/` — `GET /invoices`, `GET /orders`, `GET /payouts`, `GET /activity`, `GET /summary` read models feeding the grids.
- `src/lib/command/` — Agent Command bar view-model: brief validation, example briefs, the plan-review model (step labels, exact PayPal call, trigger badges), and the action-availability rules that mirror the server-side approval gate (approve/reject only from `pending_approval`, execute only from `approved`).
- `src/app/` — Next.js App Router UI: the operations console (Agent Command bar with plan review + approval gate, KPI strip + AG Grid Community Invoices, Orders, Payouts, and Activity/Audit grids; status pills, floating filters, pagination).

## Environment

See `.env.example`. `PAYPAL_MODE=mock|sandbox`; sandbox credentials and the optional LLM key are only read from your own environment — none are committed.
