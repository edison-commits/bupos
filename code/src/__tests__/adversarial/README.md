# Adversarial fixture corpus

Each file here is a permanent regression test for a specific **closed**
finding from an audit round. The pattern:

1. Reproduce the exact attack / scenario the finding identified.
2. Assert the fix still holds (attack fails OR the guard fires).
3. If the test ever regresses to green-but-wrong behavior, a future
   audit round catches the regression at test time, not at prod
   incident time.

**Add one test per CRITICAL + HIGH finding going forward.** MEDIUM +
LOW may be added when cheap; skipping is OK if coverage elsewhere
(e.g., ESLint rule, guardrail self-test) already enforces the fix.

## Naming convention

Files: `<round>-<id>-<short-slug>.test.ts`
Tests: describe the scenario imperatively ("Attacker strips CF
headers → signup must be rejected in prod").

## Running

These run in the **unit** test suite (`vitest.config.ts`) — fast,
no DB. Ones that need the DB live in
`src/__tests__/integration/` instead (see `race-fuzz.test.ts` for
examples).

```bash
npx vitest run src/__tests__/adversarial
```
