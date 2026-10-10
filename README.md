# LedgerPilot

An AI money operator for solo sellers and freelancers. You say what happened in plain English — LedgerPilot drafts, sends, tracks, and reconciles the money through PayPal. Every action is proposed first and executed only on approval, and every step is written to an auditable operations console.

> PayPal AI Hackathon entry (sandbox only — no real money moves anywhere in this project).

## Status

Foundations milestone: Next.js + TypeScript scaffold and a complete mock-first PayPal adapter layer. The agent plan/execute pipeline, webhook handler, and AG Grid operations console land in the following milestones.

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
- `src/app/` — Next.js App Router UI.

## Environment

See `.env.example`. `PAYPAL_MODE=mock|sandbox`; sandbox credentials and the optional LLM key are only read from your own environment — none are committed.
