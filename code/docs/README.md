# BUPOS Docs Index

Use this directory for operational and engineering references that are current enough to guide work in `code/`.

## Start here

- `../README.md` — app setup, test suites, guardrails, architecture notes.
- `../../README.md` — repo-level orientation, current backlog buckets, escalation boundaries.
- `KNOWN_ISSUES.md` — central tracker for audit findings and closure evidence.

## Operations

- `runbook-deploy.md` — deploy flow and deployment checks.
- `runbook-rollback.md` — rollback flow.
- `runbook-alerting.md` — alerting/monitoring notes.
- `runbook-061-duplicates.md` — duplicate-record runbook.

## Architecture and schema

- `architecture.md` — system architecture notes.
- `schema/` — historical/schema reference SQL. Canonical runtime migrations live in `../supabase/migrations/`.

## Feature/operator docs

- `bupos-help-cheat-sheet.md` — source copy for the operator Help cheat sheet.
- `../public/docs/bupos-help-cheat-sheet.md` — public copy. Keep it byte-identical to `bupos-help-cheat-sheet.md`.

## Historical follow-ups

- `ROUND8_FOLLOWUPS.md` — resolved Round 8 follow-ups and remaining ops notes.

## Maintenance rules

- Do not add generated output, test results, screenshots, or local machine artifacts here.
- Prefer one current index/update over adding another stale status document.
- When a deferred audit item is fixed, update `KNOWN_ISSUES.md` with the acceptance evidence or remove the open section if no longer relevant.
