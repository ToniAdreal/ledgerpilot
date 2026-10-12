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

- **Checkout page.** The checkout orders have their own addressable
  page at `/checkout` (the page CONCEPT.md §3.1 lists as the
  "Sell something" flow): the same read model and route as the
  console's Orders grid, rendered full-width with the console's
  state and CSV-export view-models and the Buyer view per payable
  order. Read-only as a list — creating orders and capturing stay
  in the console.
- **Invoices page.** The invoice list has its own addressable page
  at `/invoices` (the list half of the page CONCEPT.md §3.1 lists
  as "invoice list + detail"): the same read model and route as
  the console's Invoices grid, rendered full-width with the
  console's state and CSV-export view-models, each invoice number
  linking to its detail timeline at `/invoices/[id]`. Read-only
  as a list — creating, recording payments, and approving stay
  in the console.
- **Activity page.** The agent activity & webhook audit trail has
  its own addressable page at `/activity` (the page CONCEPT.md §3.1
  lists for the audit grid): the same read model and route as the
  console's Activity grid, rendered full-width with the console's
  state and CSV-export view-models. Read-only — actions stay in
  the console.
- **Invoice record-payment leg.** Any open invoice — not only the
  Judge Mode spine invoice — can be recorded as paid in-app: the
  console's Record payment action and
  `POST /api/paypal/invoices/record-payment` (full amount due, or an
  explicit partial amount) call the Invoicing record-payment API,
  audit-log the exact call, and process the resulting
  `INVOICING.INVOICE.PAID` event through the sync reconciler so a
  trigger-gated payout bound to that invoice fires. Amounts are
  validated before any call; re-recording a paid invoice is a no-op.
- **Reminder form + draft wrapper.** `POST /api/paypal/reminders`
  drafts a `send_reminder` plan (payload-identical to the parser's
  reminder step) and the console's structured “Send a reminder” form
  drafts through the same approval gate — completing the structured
  draft + form set for all four typed actions.
- **Invoice form.** The console's structured “New invoice” form
  (recipient, optional email, description, amount, currency, optional
  due date / note / reference) drafts an invoice through the approval
  gate — the structured surface for the Invoicing draft endpoint,
  completing the structured-form set whose sell form and payout batch
  builder already shipped. Its validation mirrors the server's draft
  rules, including the real-calendar due-date rule.
- **Sell form.** The console's structured “Sell something” form
  (description, amount, currency, optional reference) drafts a
  checkout order through the approval gate — the structured seller
  surface for the Orders draft endpoint, completing the checkout
  sketch whose buyer surface (Buyer view + Capture) already shipped.
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
  the same loops on instances webhooks cannot reach, and the console's
  Sync from PayPal button runs it in place with a validated,
  honestly-summarised outcome (resumed plans named; an idempotent
  re-run reported as nothing new).
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
- **Publish-day smoke script.** `npm run smoke`
  (`scripts/smoke.mjs`, zero dependencies) drives one full Judge
  Mode loop over HTTP against a running instance — health, reset,
  seed, approve, execute, pay, summary — and asserts the exact
  post-loop totals the README promises, per currency. It resets the
  target first so it is re-runnable, which is also its safety rule:
  disposable mock-mode demo instances only; it reads no credentials.
- **Deployment readiness.** `GET /api/health` reports
  ok / degraded / misconfigured from the environment alone, as
  booleans and missing-variable names only — never a credential
  value. A Render Blueprint (`render.yaml`) deploys the hosted demo
  in mock mode with every credential variable declared `sync: false`.
- **Container deployment.** A `Dockerfile` packages the same hosted
  demo for any container host: every stage pins Node 22, the image
  builds and starts with the package's own scripts as the non-root
  `node` user, defaults to credential-free mock mode (no secret
  value is ever baked into the image — sandbox credentials are a
  runtime decision), and health-checks `GET /api/health`.
  `.dockerignore` keeps `.env` files, local snapshots, dependencies,
  and build output out of the build context.
- **Repository façade.** MIT `LICENSE`, `SECURITY.md` with private
  vulnerability reporting, `CONTRIBUTING.md`, issue forms and a pull
  request template, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1),
  Dependabot proposals, a CI workflow running typecheck → test →
  build with no secrets, and the Node 22 runtime pin (`.nvmrc`,
  `package.json` `engines`).
- **Package license metadata.** The SPDX identifier `MIT` is also
  declared in the `package.json` metadata (mirrored in the
  `package-lock.json` root entry), so package tooling reads the
  same license as the root `LICENSE` file it previously had to
  discover on its own; the three declarations are kept in
  agreement by tests.
- **Support routing.** `SUPPORT.md` states the whole support
  route: best-effort with no SLA and no invented contact channel,
  self-diagnosis via `GET /api/health` and Judge Mode first, bugs
  and feature requests through the issue forms, vulnerabilities
  and conduct concerns routed privately (never a public issue),
  and the honest scope limits.
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
- **Apple touch icon.** The `apple-icon` file convention generates a
  180×180 PNG touch icon (the app icon's ledger-rows motif in its own
  colours, full-bleed because Apple masks the corners itself) —
  iOS / Safari do not use the SVG favicon or the manifest's SVG icon
  for the touch surface, so the hosted demo previously had no touch
  icon on Apple devices. No external asset or font is fetched.
- **Repository text hygiene.** `.editorconfig` declares the tree's
  text conventions where editors read them (UTF-8, LF, final
  newline, no trailing whitespace, space indentation — Markdown
  exempt from the trim rule, Python at 4), and `.gitattributes`
  declares the same LF rule to Git and marks icon assets binary,
  protecting the byte-pinned `favicon.ico` from line-ending
  conversion. The three tracked files that lacked a final newline
  (`.nvmrc`, `package.json`, `tsconfig.json`) now carry one, and
  tests keep the declarations in agreement and the tree compliant.
- **Code owners.** `.github/CODEOWNERS` routes review on the public
  repository: LedgerPilot is a solo project, so a default rule
  covers the whole tree and the security- and automation-sensitive
  surfaces (workflows, Dependabot config, `SECURITY.md`, the
  deployment descriptor, this file) are explicitly owned — every
  rule names the same one project owner, by GitHub username only.
- **Legacy ICO favicon.** `src/app/favicon.ico` (16 / 32 / 48 px,
  classic 32-bpp BMP entries) redraws the same motif for the
  `/favicon.ico` surface browsers and tooling still request directly
  — the one icon request that 404'd while only the modern
  conventions existed. It is generated deterministically by
  `scripts/generate-favicon.py` (Python standard library only) and
  committed; because the entries are uncompressed, tests assert the
  rendered pixels, including the translucent row composited over
  the ink.
- **Accessibility shell.** A "Skip to main content" link is the root
  layout's first focusable element — off-viewport until focused, then
  pinned visible — targeting each page's single
  `<main id="main-content" tabIndex={-1}>` landmark; a global
  `:focus-visible` outline keeps keyboard focus visible (no stylesheet
  rule removes an outline without replacing it), and a
  `prefers-reduced-motion` query collapses animations, transitions,
  and smooth scrolling.
- **CodeQL code scanning.** A `.github/workflows/codeql.yml`
  workflow scans the shipped JavaScript/TypeScript on every push
  and pull request and on a weekly schedule, reporting to GitHub
  code scanning. Extraction uses `build-mode: none` (scanning never
  runs project scripts), permissions are limited to reading the
  repository and writing scanning results, and no secrets are
  involved — the static-analysis complement to the CI gate and
  Dependabot.
- **Page metadata.** Every addressable page — the Operations
  Console, Judge Mode, invoice detail, and the 404 surface — now
  carries its own typed `Metadata` export with a distinct title and
  description, so tabs and shares name the surface instead of the
  bare app name the console previously inherited from the root
  layout. No page declares a URL or canonical before a public host
  exists.

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
