# LedgerPilot

An AI money operator for solo sellers and freelancers. You say what happened in plain English — LedgerPilot drafts, sends, tracks, and reconciles the money through PayPal. Every action is proposed first and executed only on approval, and every step is written to an auditable operations console.

> PayPal AI Hackathon entry (sandbox only — no real money moves anywhere in this project).

## Status

Core loop, part 1: the deterministic agent pipeline is live — a plain-English brief becomes a typed action plan, nothing executes without approval, and a payout gated on invoice payment stays deferred until the payment lands. The webhook handler, sync reconciler, and AG Grid operations console land in the following milestones.

Try it against the running dev server:

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
- `src/app/api/agent/` — `POST /plan` (brief → plan), `POST /approve` (the approval gate), `POST /execute` (approved plans only).
- `src/app/` — Next.js App Router UI.

## Environment

See `.env.example`. `PAYPAL_MODE=mock|sandbox`; sandbox credentials and the optional LLM key are only read from your own environment — none are committed.
