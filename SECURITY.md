# Security Policy

LedgerPilot is a hackathon project that operates money-shaped flows
against the **PayPal sandbox and a local mock only**. There is no
real-money mode, and no real PayPal account should ever be connected
to a public deployment of this code.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private
vulnerability reporting for this repository (**Security → Report a
vulnerability**). Do not open a public issue for a vulnerability, and
never include real credentials, tokens, or personal data in a report —
a description of the flaw and a reproduction against the mock or your
own sandbox app is enough.

## Supported state

Only the latest state of the default branch is supported. LedgerPilot
is pre-1.0 hackathon software; there are no maintained release lines.

## Security model (what the code enforces)

- **Approval gate:** nothing executes against PayPal without a typed
  action plan plus an explicit approval record — this holds for the
  console, the natural-language parser, the optional LLM adapter, and
  the `POST /api/paypal/*` draft endpoints alike. There is no API
  surface that moves money directly.
- **Webhook trust:** webhook events are signature-verified through
  PayPal's verify endpoint before any state changes, and event ids are
  processed exactly once. An unverifiable event is logged and refused.
- **Secrets:** credentials are read from environment variables only
  (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`,
  the optional `LLM_API_KEY`). They are never committed — the
  deployment descriptor (`render.yaml`) declares them `sync: false`
  so no value is stored in this repository — and the readiness report
  (`GET /api/health`) exposes presence booleans and variable names
  only, never values.
- **LLM boundary:** the optional LLM adapter is off by default. When
  enabled, it only proposes an extraction; deterministic code
  validates every field (step types, currencies, amount caps, real
  calendar dates) and a malformed proposal is rejected whole.
- **Read-only surfaces:** Disputes and Transaction Search are read
  only. Dispute-evidence summaries are drafts for a human to review —
  the app never submits evidence to PayPal.

## Deployment guidance

- The hosted demo is intended to run in the default **mock mode**
  with no credentials at all.
- Judge Mode's seed / simulate-payment / reset endpoints are demo
  controls for that disposable mock instance. The reset refuses to
  run in sandbox mode. Do not expose a sandbox-mode instance publicly
  without putting your own access controls in front of it — sandbox
  credentials operate a real (test-money) PayPal account.
- If you fork this project, use credentials from **your own** PayPal
  Developer app, created in your own developer account.
