# Support

LedgerPilot is a PayPal AI Hackathon project: pre-1.0, maintained on
a best-effort basis by its maintainers, with no support SLA, no
support email address, and no phone or chat channel. This file is
the whole support route — every request goes through GitHub, and
the sections below say which door to use for which problem.

## Before you ask

Most setup problems answer themselves:

- **Run the readiness check first.** `GET /api/health` on your
  instance reports `ok`, `degraded`, or `misconfigured` from the
  environment alone, naming any missing variable. It exposes
  presence booleans and variable names only, never values — the
  status line is safe to paste into a report.
- **Check your mode.** Mock mode (`PAYPAL_MODE` unset or `mock`)
  needs no credentials and runs the full loop. Sandbox mode needs
  credentials from your own PayPal Developer app — see
  `.env.example` and the README's local-run section.
- **Try Judge Mode.** `/judge` seeds the fictional demo scenario
  (Ana, Marco, Sam Rivera) with one click, so you can tell whether
  the app itself works before debugging your own brief or data.

## Bugs

Open the **bug report** form (Issues → New issue → Bug report).
Include the commit or version, your mode (mock or sandbox — never
any credential value), the `/api/health` status line, and the
steps, expected behaviour, and actual behaviour the form asks for.

## Feature requests

Open the **feature request** form (Issues → New issue → Feature
request). LedgerPilot's scope is the approval-gated operation of
PayPal sandbox and mock flows; a request that needs a real-money
mode or a bypass of the approval gate is out of scope by design.

## Security vulnerabilities — never a support request

Do not open a public issue for a vulnerability, and do not use the
bug form for one. Follow [SECURITY.md](./SECURITY.md) and report
privately through GitHub's private vulnerability reporting
(Security → Report a vulnerability), never with real credentials,
tokens, or personal data in the report.

## Conduct concerns

Report conduct concerns privately through GitHub, exactly as
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) describes — never in a
public issue.

## Contributing

Questions about a change you are making belong on the pull request
itself; [CONTRIBUTING.md](./CONTRIBUTING.md) is the contributor
contract (the verification gate, the invariants, and the PR
expectations).

## What support cannot do

- It cannot access, recover, or configure your PayPal account or
  your sandbox app — those live in your own PayPal Developer
  account, and no maintainer will ever ask for your credentials.
- It cannot move real money: LedgerPilot has no real-money mode.
- It covers only the latest state of the default branch — there
  are no maintained release lines to backport fixes to.
