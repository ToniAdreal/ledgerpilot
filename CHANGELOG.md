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

- **LLM connection failure (fixed message).** A call to the optional
  LLM endpoint that gets no complete response — a refused
  connection, a DNS failure, a reset before or during the body —
  now surfaces as a fixed `LlmExtractionError` message, never the
  transport error's own text (which the adapter previously embedded
  verbatim). This mirrors the sandbox adapter's `CONNECTION_FAILED`
  discipline; an HTTP error status keeps its shape ahead of the
  translation, a timer-caused abort stays the timeout, and
  `parseBriefWithFallback` still rethrows the deterministic
  parser's original error.
- **Sandbox connection failure (`CONNECTION_FAILED`).** A PayPal
  call that gets no response at all — a refused connection, a DNS
  failure, a reset mid-body — is now translated at the sandbox
  adapter's transport choke point into a `PayPalError` of status
  502 and name `CONNECTION_FAILED` naming the request (method +
  path) only, never the transport error's own text. Without it,
  the raw fetch error escaped every route layer that translates
  only `PayPalError` as an opaque HTML 500. Errors that are
  already `PayPalError`s (e.g. `RESPONSE_TOO_LARGE`) keep their
  shape, and a timeout stays the 504 `REQUEST_TIMEOUT`.
- **Sandbox request idempotency (`PayPal-Request-Id`).** Every
  mutating (POST) call the sandbox adapter makes now carries a
  unique `PayPal-Request-Id` header, so a retry of the same call
  is deduplicated by PayPal instead of creating a second
  resource or moving money twice. Each logical call mints a new
  id; reads, the OAuth token fetch, and webhook-signature
  verification carry none.
- **Outbound body-read timeout.** Both outbound adapters'
  per-request timers now span the response body, not just the
  wait for the headers: an endpoint that answers promptly and
  then never finishes its body is aborted by the same bound —
  on the sandbox adapter as the same 504 `REQUEST_TIMEOUT`
  (the OAuth token body included), and on the optional LLM
  adapter as an `LlmExtractionError` timeout that still falls
  back to the deterministic parser's error.
- **Outbound response-size bounds.** The sandbox timeout bounds how
  long an outbound call may take; these bound how much it may
  return. The sandbox adapter measures every response body — the
  OAuth token response and error responses included — in UTF-8
  bytes before parsing, and refuses a body over
  `SANDBOX_MAX_RESPONSE_BYTES` (4 MiB) with a `PayPalError` of
  status 502 and name `RESPONSE_TOO_LARGE` naming the limit only.
  The optional LLM adapter does the same at
  `LLM_MAX_RESPONSE_BYTES` (256 KiB), refusing before parsing and
  still falling back to the deterministic parser's error.
- **Webhook verification unavailable (the structured 502).**
  Signature verification in sandbox mode is itself a PayPal API
  call, and that call can fail; a throw from the adapter is now
  caught by the webhook handler and reported as a distinct
  `verification_unavailable` outcome — the event is left
  unprocessed (a redelivery after recovery processes normally),
  it is never recorded as a signature rejection, and
  `POST /api/paypal/webhooks` answers a structured 502 in the
  shared `{ error }` shape so PayPal redelivers the event. The
  OpenAPI document declares the 502 on the webhook operation.
- **Judge Mode payment guard (mock mode only).** Simulating the
  spine invoice's payment now refuses in sandbox mode, before
  touching anything — completing the mock-only parity of the three
  Judge Mode demo controls (seed, payment simulation, reset). The
  spine invoice only exists in the mock, and a simulated
  record-payment is not how a sandbox invoice is paid.
  `POST /api/judge/pay` maps the refusal to a 409, and the OpenAPI
  document declares that 409 on the operation.
- **Judge Mode seed guard (mock mode only).** Seeding the Judge
  Mode scenario now refuses in sandbox mode, before touching
  anything — parity with the demo reset, which already refused.
  In sandbox mode the seeded history would be created at PayPal
  for fictional recipients (invoices to Ana, Marco, and Sam
  Rivera and a payout to Marco), the captured order and the
  flagged sample dispute only exist in the mock, and a capture
  PayPal refuses would strand the sent invoices with no seed
  record. `POST /api/judge/seed` maps the refusal to a 409, and
  the OpenAPI document declares that 409 on the operation.
- **Request id (the `X-Request-Id` header).** Every response
  under `/api/` — routed responses and middleware guard refusals
  (405 / 406 / 429) alike — now carries an `X-Request-Id` header,
  resolved by the middleware before any guard runs. A valid
  client-supplied id (1–128 characters of ASCII letters, digits,
  `.`, `_`, `-`) is echoed verbatim; a missing or invalid value
  is never echoed and is replaced with a generated `req-<uuid>`.
  The id is a correlation handle, not an identity. The OpenAPI
  document declares the header on every response of every
  operation.
- **Sandbox request timeout.** Every outbound PayPal call the
  sandbox adapter makes — the OAuth token fetch included — is now
  bounded by a per-request timeout (10 seconds by default, the
  same bound the LLM adapter enforces). A PayPal endpoint that
  never answers is aborted and translated into a `PayPalError`
  with status 504 and name `REQUEST_TIMEOUT`, naming the timeout
  and the request (method + path, never a credential); fetch
  failures that are not the timeout are rethrown untouched.
- **Rate limit (the JSON 429).** A client POSTing past 120
  requests per 60-second fixed window (per client key — first
  `x-forwarded-for` entry, else `x-real-ip`, else a shared
  "direct" bucket; a flood brake, not an identity) now answers a
  JSON 429 in the shared `{ error }` shape naming the limit,
  with a `Retry-After` header, via middleware after the method
  and negotiation guards; the refused request reaches no route,
  runtime, or PayPal call. Reads are never counted, and the
  webhook listener is not exempt (PayPal retries deliveries
  answered with an error status, and verified events are
  processed exactly once). The OpenAPI document declares the
  shared 429 on every POST operation.
- **Content negotiation (the JSON 406).** Every request whose
  `Accept` header excludes `application/json` — the only
  representation the API returns — now answers a JSON 406 in the
  shared `{ error }` shape (middleware content negotiation, the
  most specific matching media range governing, `q=0` refusing).
  Requests with no `Accept` header, or accepting JSON directly or
  via a wildcard, are served as before; OPTIONS and the PayPal
  webhook listener (a machine-peer sender that does not negotiate)
  are exempt. The OpenAPI document declares the shared 406 on
  every operation except the webhook listener.
- **Content-Type enforcement (the JSON 415).** Every JSON request
  body whose declared `Content-Type` is present and not a JSON
  media type (`application/json` or an `application/*+json` suffix
  type) now answers a JSON 415 in the shared `{ error }` shape —
  naming the required `Content-Type: application/json` — before
  the body is read, so a mislabelled body reaches no parser,
  validator, runtime, or PayPal call. Requests that declare no
  Content-Type are read as before. The OpenAPI document declares
  the shared 415 on every body-bearing operation.
- **API cache control (no-store).** Every response under `/api/`
  now carries `Cache-Control: no-store` (a `next.config.mjs`
  header rule scoped to `/api/:path*` only), so no browser or
  shared cache can serve a stale copy of the live money-shaped
  state the API returns — console read models, plan state, KPIs,
  the readiness report. Pages are not covered; no cacheable
  directive is declared anywhere.
- **Request body size limit (the JSON 413).** Every JSON request
  body is measured in UTF-8 bytes before parsing and answers a
  JSON 413 in the shared `{ error }` shape — naming the 131072-byte
  (128 KiB) limit — when it exceeds the cap, so an oversized body
  reaches no validator, runtime, or PayPal call. The largest
  legitimate body (a maximum-size payout batch draft, roughly
  27 KB) sits far under the cap; the OpenAPI document declares the
  shared 413 on every body-bearing operation.
- **JSON body validation (the non-object 400).** Every POST route
  whose body is a required JSON object now reads it through one
  shared reader (`src/lib/api/body.ts`): malformed JSON and
  well-formed non-object JSON (`null`, arrays, scalars) answer the
  route's documented 400 in the shared `{ error }` shape instead
  of slipping through a cast and crashing into an opaque 500, and
  field types are checked after the shape. The suggest route's
  optional body applies the same object check; routes that take
  no body read none.
- **Method not allowed (the JSON 405).** A documented API path
  called with a method it does not support now answers a JSON 405
  in the shared `{ error }` shape — naming the method, the path,
  and the allowed methods — with an `Allow` header, via the app's
  one middleware delegating to `src/lib/api/method-not-allowed.ts`,
  which resolves allowed methods from the OpenAPI operation
  registry itself. HEAD on a GET path and OPTIONS pass through to
  the framework; unknown paths still answer the JSON 404. The
  OpenAPI document and `/api-docs` declare the same shared 405 on
  every operation.
- **Unknown API routes (the JSON 404).** Paths under `/api/` that
  no route implements now answer a JSON 404 in the shared
  `{ error }` shape (naming the requested path, pointing at
  `GET /api/openapi`) for every method, via an optional catch-all
  route delegating to `src/lib/api/unknown-route.ts` — instead of
  the page-level HTML not-found. The catch-all builds no runtime,
  so unknown paths answer 404 even on a misconfigured instance.
- **Structured API errors.** Every runtime-backed API route now
  acquires the runtime through `acquireRuntime`
  (`src/lib/api/errors.ts`): when sandbox mode is selected without
  credentials, the route answers a structured 503 in the shared
  `{ error }` shape (naming the missing variables) instead of an
  opaque framework 500; any other failure is rethrown untouched.
  The OpenAPI document and `/api-docs` carry the same shared 503
  on every runtime-backed operation.
- **Next-action suggestions.** `POST /api/agent/suggest` and the
  console's Suggest next actions button: the agent scans for
  overdue open invoices and drafts one pending-approval reminder
  plan per uncovered invoice (`source: "suggested"`), reporting
  already-covered invoices as skips with their reasons. Drafting
  only — sending still requires the ordinary approval gate.
- **Plan amendment (the plan-review Edit).** `POST /api/agent/edit`
  amends the amount/currency of a plan still pending approval
  (a batch payout step per line), so a reviewer can fix a wrong
  amount without rejecting and re-drafting. Only pending plans can
  be amended — approval always covers exactly the reviewed steps —
  amounts are validated through the resource drafts' money rules,
  step descriptions are regenerated, and the amendment is written
  to the audit log. The console plan review renders amount inputs
  and an Amend amounts action alongside Approve / Reject.
- **Site navigation.** The root layout now renders a primary nav
  on every page from a single source of truth
  (`src/lib/nav/site-nav.ts`): every addressable surface is
  reachable from every other page, the current page's link carries
  `aria-current="page"`, and the test suite requires the nav list
  to match the page routes on disk exactly.
- **PayPal mode indicator.** The console carries a mode strip
  above the KPI strip stating the instance's actual PayPal mode —
  Mock, Sandbox, Sandbox without a webhook id (sync reconciler
  named as the fallback), or Sandbox misconfigured (missing
  credential variables named as the remedy) — resolved from
  `GET /api/health` by a pure view-model that validates the
  report's wire shape, keeps only whitelisted fields, and builds
  the badge copy from configuration booleans, so no credential
  value can reach the screen through it. An unreadable report
  resolves to "unknown", never a guessed mode.
- **Verification script.** `npm run verify` runs the whole
  verification gate (`npm run typecheck && npm test && npm run build`,
  in CI's order) as one command. It installs nothing, starts no
  server, and reads no credentials; the exact command string is
  pinned by tests against the CI workflow's step order.
- **API documentation page.** The human-readable rendering of
  the OpenAPI registry at `/api-docs`: every operation grouped
  by surface with its summary, description, request-body note,
  and response codes, rendered from the same registry that
  builds `GET /api/openapi` — exactly one list of operations
  exists, so the page and the machine document cannot drift.
  The page states the no-authentication and approval-gate
  honesty notes and links the machine-readable document; the
  home console links to it.
- **Agent tool definitions.** The agent's four typed actions are
  published as tool definitions in MCP / PayPal Agent Toolkit shape
  (`{ name, description, inputSchema }`, closed schemas carrying the
  drafts' field rules), with `GET /api/agent/tools` as the discovery
  surface and `POST /api/agent/tools` drafting `source: "tool"`
  pending-approval plans from one or more validated tool calls —
  steps identical to the resource drafts, both payout-gating forms
  supported, and no execution path around the approval gate. This
  is CONCEPT.md §1's tool-layer stretch goal, built REST-first as
  planned.
- **OpenAPI document.** `GET /api/openapi` serves an OpenAPI 3.1
  document for the whole HTTP API (27 paths, 29 operations), built
  from a registry in `src/lib/api/` whose completeness the test
  suite enforces against the route files on disk. It declares a
  single relative server (no invented host), no credentials, and
  `security: []` on every operation — the API has no authentication
  layer, and the document says so, with the deployer-access-controls
  warning for publicly exposed instances.
- **Sandbox verification smoke.** `npm run smoke:sandbox`
  (`scripts/smoke-sandbox.mjs`, zero dependencies) automates the
  sandbox exit test against a running sandbox-mode instance: it
  refuses a mock-mode or misconfigured target at the health step
  before drafting anything, then drives the invoice →
  record-payment, payout, and order legs through the approval
  gate with fictional verification amounts, verifies the buyer
  checkout link is a real PayPal URL (capture deliberately not
  attempted — it needs the buyer's hosted-checkout approval), and
  finishes with the sync reconciler. It reads no credentials;
  credentials live in the target instance's own environment.
- **Reconciliation page.** The signed Transaction Search ledger
  has its own addressable page at `/transactions`: the same read
  model and route as the console's Reconciliation grid, rendered
  full-width with the console's state and CSV-export view-models,
  signed amounts (payouts out negative, in red). Read-only end
  to end — Transaction Search never moves money. With this page,
  every console grid has a standalone route.
- **Disputes page.** The disputes list has its own addressable
  page at `/disputes`: the same read model and route as the
  console's Disputes grid, rendered full-width with the console's
  state and CSV-export view-models, response deadlines with
  overdue highlighting, and seeded rows flagged "Sample". The
  draft-only evidence summary is carried over as a GET-only,
  never-submitted draft — the Disputes integration stays
  read-only end to end.
- **Command page.** The Agent Command bar has its own addressable
  page at `/command` (the plan-review surface CONCEPT.md §3.1
  lists, "or console drawer"): the console's own CommandBar
  rendered standalone — brief → typed plan review with the exact
  PayPal calls and trigger-gated steps marked → approve / reject /
  execute through the same server-side approval gate, driving
  only the `/api/agent/*` routes and never calling PayPal
  directly.
- **Payouts page.** The payouts list has its own addressable page
  at `/payouts` (the list surface of the page CONCEPT.md §3.1
  lists as the payout batch builder): the same read model and
  route as the console's Payouts grid, rendered full-width with
  the console's state and CSV-export view-models, one row per
  payout item with its batch context flattened in. Read-only
  as a list — drafting batches and releasing payouts stay in
  the console.
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
