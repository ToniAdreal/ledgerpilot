## What changed

<!-- One focused change. What does it do, and why? Link the issue
     it closes, if any. -->

## Verification

The CI gate (`.github/workflows/ci.yml`) runs the same sequence —
all three must pass:

- [ ] `npm run typecheck` — clean
- [ ] `npm test` — fully green (new behaviour has new tests)
- [ ] `npm run build` — succeeds

## Invariants

- [ ] Nothing moves money without a typed plan plus an explicit
      approval — no new surface bypasses the gate
- [ ] No real credentials, tokens, or personal data anywhere in
      the change (fake fixtures and `.env.example` placeholders
      only); demo data stays fictional and sample data stays
      labeled as sample
- [ ] Money is never summed across currencies; AG Grid stays
      Community tier only
