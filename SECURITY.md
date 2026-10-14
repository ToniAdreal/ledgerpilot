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
- **HTTP security headers:** every response (pages and API routes)
  carries the baseline set configured in `next.config.mjs`: a
  same-origin Content-Security-Policy (`default-src 'self'`,
  `object-src 'none'`, `frame-ancestors 'none'` — no wildcard and no
  external origin, because all assets are bundled and PayPal / LLM
  traffic is server-side only; inline scripts/styles are allowed for
  the App Router bootstrap and inline style attributes, and eval is
  allowed in development only), HSTS without a preload claim,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a
  strict-origin referrer policy, and a Permissions-Policy disabling
  camera, microphone, and geolocation. The framework's
  `X-Powered-By` header is disabled.
- **Request correlation:** every response under `/api/` carries an
  `X-Request-Id` header — the client's own id echoed only when it
  matches a strict whitelist shape (1–128 characters of ASCII
  letters, digits, `.`, `_`, `-`), a generated `req-<uuid>`
  otherwise, so arbitrary header text is never reflected into a
  response or a log. The id is a correlation handle for operator
  reports, not an identity or authentication control, and no
  decision in the app is made from it.
- **API cache control:** every response under `/api/` carries
  `Cache-Control: no-store` (configured in `next.config.mjs`,
  scoped to `/api/:path*` only). API responses carry live
  money-shaped state — console read models, plan state, KPIs — and
  no browser or shared cache may serve a stale copy of them; pages
  are not covered, because they are server-rendered shells whose
  data comes from the API at runtime.

## Deployment guidance

- The hosted demo is intended to run in the default **mock mode**
  with no credentials at all.
- Judge Mode's seed / simulate-payment / reset endpoints are demo
  controls for that disposable mock instance. The seed and the reset
  refuse to run in sandbox mode (before touching anything). Do not
  expose a sandbox-mode instance publicly
  without putting your own access controls in front of it — sandbox
  credentials operate a real (test-money) PayPal account.
- If you fork this project, use credentials from **your own** PayPal
  Developer app, created in your own developer account.
