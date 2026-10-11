# Changelog

All notable changes to LedgerPilot are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

LedgerPilot has not been publicly released yet. The first public
release, 0.1.0, is the PayPal AI Hackathon entry: the public repository
and the hosted demo launch on 2026-11-01. Everything below is therefore
listed under Unreleased — no version is claimed as released before
that date, and the commit history in the repository is the detailed
build record behind these summaries.

## [Unreleased]

### Added

- **Approval-gated agent pipeline.** A plain-English brief becomes a
  typed action plan (`create_invoice`, `create_order`, `draft_payout`,
  `send_reminder`) through a deterministic parser — no API key needed.
  Nothing executes without an explicit approval record, on any surface:
  the console command bar, the natural-language parser, the optional
  LLM adapter, and the resource draft endpoints all pass through the
  same gate.
- **PayPal adapter layer.** One contract with a full in-memory mock
  (default, zero credentials) and a sandbox REST implementation
  (Invoicing v2, Orders v2, Payouts, Disputes and Transaction Search
  read-only), selected by `PAYPAL_MODE`. The sandbox adapter is wired
  and stub-tested; it has not yet been exercised against a live
  sandbox account.
- **Verified, idempotent webhooks plus a sync reconciler.** Webhook
  deliveries are signature-verified before they are trusted and each
  event id is processed exactly once; trigger-gated steps resume only
  for the resource they were bound to. The polling reconciler closes
  the same loops on instances webhooks cannot reach.
- **AG Grid operations console.** Invoices, Orders / Checkout, Payouts,
  Disputes (read-only), Reconciliation — Transaction Search
  (read-only), and the combined Agent Activity & Webhook audit grid,
  with a KPI strip, per-grid loading / error / empty / filtered-empty
  states, CSV export, and change-flash on state flips such as an
  invoice turning PAID. Money totals are grouped per currency and
  never summed across currencies. Row grouping is deliberately not
  used: it is an AG Grid Enterprise feature and this project ships
  Community edition only.
- **Ask-the-grid.** Plain-language questions compile into validated
  AG Grid filter models; invalid or inapplicable queries change
  nothing and say why.
- **Judge Mode.** One click seeds a fictional demo scenario (Ana,
  Marco, Sam Rivera) with the demo-spine plan left in
  `pending_approval`, so a judge runs the real approval gate, the
  invoice payment leg, and the gated payout end to end with no
  account and no keys. A mock-mode-only reset returns a completed
  demo to a fresh slate without reusing any id; reset refuses in
  sandbox mode.
- **Invoice detail and dispute evidence.** An invoice detail page
  with a webhook-fed status timeline and related plans, and
  draft-only dispute-evidence summaries built only from records the
  app actually holds — delivery proof is always reported as a gap,
  never asserted.
- **Payout batch builder.** Per-line validated multi-recipient batch
  drafts, in a console form and over the resource API, executing as
  exactly one Payouts batch through the approval gate.
- **Optional LLM adapter.** Off by default and consulted only when
  the deterministic parser finds no money action; its output is
  strictly validated in code, and any failure falls back to the
  parser's original error.
- **Opt-in persistence.** File-backed snapshot stores for the ledger
  and for the mock adapter (`LEDGERPILOT_STORE_FILE`,
  `PAYPAL_MOCK_STORE_FILE`) survive a restart; corrupt or unsupported
  snapshots are refused loudly and never overwritten.
- **Deployment readiness.** `GET /api/health` reports
  ok / degraded / misconfigured from the environment alone, as
  booleans and missing-variable names only — never a credential
  value. A Render Blueprint (`render.yaml`) deploys the hosted demo
  in mock mode with every credential variable declared `sync: false`.
- **Repository façade.** MIT `LICENSE`, `SECURITY.md` with private
  vulnerability reporting, `CONTRIBUTING.md`, issue forms and a pull
  request template, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1),
  Dependabot proposals, a CI workflow running typecheck → test →
  build with no secrets, and the Node 22 runtime pin (`.nvmrc`,
  `package.json` `engines`).
- **Branded app shell.** App Router special files in the project's
  own voice instead of the framework defaults: a branded 404 page,
  error and global-error boundaries that offer a retry and never
  render the raw error or stack, an accessible loading state, a
  file-convention app icon, and a `robots.txt` that allows the
  public pages while keeping `/api/` out of search indexes.
- **Web app manifest.** `/manifest.webmanifest` carries the app's
  identity (name, description, start URL, the app icon, theme and
  background colours taken from the app itself), and the root layout
  carries matching Open Graph / Twitter share metadata and a theme
  colour. Identity metadata only — no service worker, no offline
  mode, and no public URL is declared before one exists.
- **Generated share image.** The `opengraph-image` / `twitter-image`
  file conventions generate a 1200×630 PNG share card (the app's name
  and one-liner in its own colours, no external asset or font fetched),
  replacing a hand-declared share image that pointed at the square
  SVG icon — a format share crawlers do not render, so link previews
  would have been blank. The Twitter card is now
  `summary_large_image`.

### Security

- Webhook events are never trusted before signature verification,
  and gated payouts are bound to the invoice that must be paid first,
  so one plan's payment cannot release another plan's payout.
- No credentials are stored in the repository; the health report and
  the deployment descriptor carry variable names and booleans only.
- Every response carries HTTP security headers (`next.config.mjs`):
  a same-origin Content-Security-Policy with no wildcard or external
  origin, HSTS without a preload claim, and anti-sniffing,
  anti-framing, referrer, and device-permission baselines; the
  framework's `X-Powered-By` header is disabled.

## [0.1.0] — pending

First public release, planned for 2026-11-01 with the public
repository launch. This section will be dated and finalised at
release time from the Unreleased notes above; until then, treat
Unreleased as the accurate state of the project.
