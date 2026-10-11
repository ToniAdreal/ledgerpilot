# Contributing to LedgerPilot

LedgerPilot is a PayPal AI Hackathon project. Contributions are
welcome — bug reports, documentation fixes, and pull requests alike.
This guide is the whole contract: follow it and a maintainer can
review your change without guesswork.

## Before you start

- **Be kind and harassment-free.** Participation is governed by
  [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) (Contributor Covenant
  2.1). Report conduct concerns privately through GitHub — never in
  a public issue.
- **Security flaws are not issues.** If you found a vulnerability,
  follow [SECURITY.md](./SECURITY.md) and report it privately —
  never open a public issue for it.
- **Sandbox and mock only.** LedgerPilot has no real-money mode.
  Never use a real PayPal account, never commit real credentials,
  and never include real credentials, tokens, or personal data in
  an issue, a pull request, or a test. The demo data is fictional
  (Ana, Marco, Sam Rivera); keep new examples fictional too.
- **Your own credentials, if any.** Mock mode needs none. Sandbox
  mode uses credentials from your own PayPal Developer app, set
  through environment variables — see `.env.example`.

## Running the project

```bash
npm install
npm run dev        # mock mode by default — no keys, no PayPal account
```

Node 22 is the pinned runtime (`.nvmrc` and the `package.json`
`engines` floor carry it locally; CI and the deployment descriptor
pin the same major, and the test suite keeps all five sites in
agreement). Judge Mode at `/judge` seeds the full demo scenario with
one click.

## The verification gate

Every change must pass the same sequence CI runs
(`.github/workflows/ci.yml`), in this order:

```bash
npm run typecheck  # TypeScript strict — must be clean
npm test           # vitest — must be fully green
npm run build      # Next.js production build — must succeed
```

The suite is fully offline: it runs against the mock PayPal adapter
and a stubbed sandbox fetch, with fake credentials only, so no
network or account is needed to verify a change. If a test fails
on your machine, it will fail in CI too — fix the cause, do not
skip or weaken the test to get green.

## House rules the tests enforce

Some project invariants are pinned by tests, not just documented.
A pull request that breaks one will fail CI:

- **Approval gate:** nothing moves money without a typed action
  plan plus an explicit approval record — on every surface (the
  console, the natural-language parser, the optional LLM adapter,
  and the `POST /api/paypal/*` draft endpoints, which only draft).
- **Deterministic-first AI:** the deterministic parser is the
  default brain. The optional LLM adapter is off by default, is
  consulted only when the parser finds no action, and every field
  it proposes is validated in code before it can become a plan.
- **Webhook trust:** events are signature-verified before any
  state change and processed exactly once; an unverifiable event
  is logged and refused.
- **Money is never summed across currencies**, in read models,
  totals, or copy.
- **Honesty in surfaces:** sample data stays labeled as sample,
  mock checkout links are labeled as mock, and no surface invents
  a fact (a timestamp, a delivery, a payment) the records do not
  carry.
- **Community tier only:** AG Grid Community features only — no
  Enterprise modules, no trial watermarks.
- **Secrets:** credentials come from environment variables only
  and are never committed; `.env.example` placeholders and test
  fixtures are the only credential-shaped strings in the tree.

## Pull requests

- One focused change per pull request; keep unrelated refactors
  out.
- Describe what changed and why, and how you verified it (the
  gate above). The pull request template has the checklist.
- New behaviour needs new tests, in the existing style: pure
  view-models and adapters are unit-tested, and façade files
  (CI, deployment, community health) are pinned by shape tests.
- Do not squash or rewrite the existing history — the commit arc
  is part of the project's story.
- Dependency updates arrive as Dependabot pull requests and follow
  the same gate; nothing auto-merges.

## Reporting bugs and requesting features

Use the issue templates. A good bug report names the mode
(mock / sandbox), the exact steps, what you expected, and what
happened — a failing plan id or webhook event id from the
Activity grid is the most useful detail you can include.
