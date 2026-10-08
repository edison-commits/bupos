# Documentation index

Use this page to decide whether a document is current guidance or retained evidence. Historical, audit, and specification files are intentionally preserved; they do not override current source, workflows, migrations, or the documents in the first section.

## Current guidance

- [Repository orientation](../README.md) — first-run commands and repository map
- [Application README](../code/README.md) — local development, checks, and code ownership
- [Current architecture](../code/docs/architecture.md) — runtime components and request/data flow
- [Environment and configuration ownership](../code/docs/configuration.md) — names and owners only, no values
- [Deploy runbook](../code/docs/runbook-deploy.md) — production deployment boundary and manual recovery path
- [Rollback runbook](../code/docs/runbook-rollback.md) — Worker-first rollback policy
- [Alerting runbook](../code/docs/runbook-alerting.md) — operational alerts and logs
- [Duplicate-data runbook](../code/docs/runbook-061-duplicates.md) — migration-specific remediation
- [Desktop shell README](../desktop/README.md) — Electron packaging and runtime model
- [Adversarial test convention](../code/src/__tests__/adversarial/README.md) — permanent audit regression fixtures

## Current audit history and issue evidence

These files explain prior findings or unresolved follow-ups. Verify every claim against current source before acting.

- [`code/docs/KNOWN_ISSUES.md`](../code/docs/KNOWN_ISSUES.md)
- [`code/docs/ROUND8_FOLLOWUPS.md`](../code/docs/ROUND8_FOLLOWUPS.md)
- [`AUDIT_REPORT.md`](../AUDIT_REPORT.md)
- [`AUDIT_REPORT_V2.md`](../AUDIT_REPORT_V2.md)
- [`AUDIT_CONSOLIDATED_V3.md`](../AUDIT_CONSOLIDATED_V3.md)
- [`AUDIT_CLAUDE.md`](../AUDIT_CLAUDE.md)
- [`code/AUDIT_CODEX.md`](../code/AUDIT_CODEX.md)
- [`code/AUDIT_FORGE_2026-04-25.md`](../code/AUDIT_FORGE_2026-04-25.md)
- [`code/SECURITY_AUDIT_2026-05-09.md`](../code/SECURITY_AUDIT_2026-05-09.md)

## Historical plans, milestones, and specifications

These describe earlier intended states or completed milestones. They are reference material, not setup or architecture authority.

- [`SwiftPOS_Starting_Brief.md`](../SwiftPOS_Starting_Brief.md)
- [`SwiftPOS_Kickoff_Packet.md`](../SwiftPOS_Kickoff_Packet.md)
- [`SwiftPOS_Phase1_Engineering_Plan.md`](../SwiftPOS_Phase1_Engineering_Plan.md)
- [`SwiftPOS_Phase1_Trimmed_Roadmap.md`](../SwiftPOS_Phase1_Trimmed_Roadmap.md)
- [`SwiftPOS_Phase2_Plan.md`](../SwiftPOS_Phase2_Plan.md)
- [`SwiftPOS_Milestone_Tickets_Phase1.md`](../SwiftPOS_Milestone_Tickets_Phase1.md)
- [`milestone-0.5.md`](../milestone-0.5.md)
- [`SwiftPOS_PROGRESS_LOG.md`](../SwiftPOS_PROGRESS_LOG.md)
- [`SwiftPOS_Schema_Revision_Brief.md`](../SwiftPOS_Schema_Revision_Brief.md)
- [`SwiftPOS_Master_Spec_v1.5.md`](../SwiftPOS_Master_Spec_v1.5.md)
- [`SwiftPOS_Spec_Additions_v1.5.md`](../SwiftPOS_Spec_Additions_v1.5.md)
- [`SwiftPOS_Product_Spec_v1.1.docx`](../SwiftPOS_Product_Spec_v1.1.docx)
- [`SwiftPOS_Product_Spec_v1.4.docx`](../SwiftPOS_Product_Spec_v1.4.docx)
- [`code/forge-plan.md`](../code/forge-plan.md)

## Historical implementation and support notes

These can contain useful rationale or QA scenarios, but they may describe old route shapes or completed work.

- [`code/SHIFT_CLOSE_IMPLEMENTATION.md`](../code/SHIFT_CLOSE_IMPLEMENTATION.md)
- [`code/RBAC_AND_AUDIT_IMPLEMENTATION.md`](../code/RBAC_AND_AUDIT_IMPLEMENTATION.md)
- [`code/CUSTOMER_DISPLAY_IMPLEMENTATION.md`](../code/CUSTOMER_DISPLAY_IMPLEMENTATION.md)
- [`code/CUSTOMER_DISPLAY_INTEGRATION_GUIDE.md`](../code/CUSTOMER_DISPLAY_INTEGRATION_GUIDE.md)
- [`code/CUSTOMER_DISPLAY_BUILD_SUMMARY.md`](../code/CUSTOMER_DISPLAY_BUILD_SUMMARY.md)
- [`code/CUSTOMER_DISPLAY_QUICK_REFERENCE.md`](../code/CUSTOMER_DISPLAY_QUICK_REFERENCE.md)
- [`support-pack/`](../support-pack/) — historical workflow, checkout, and QA reference material

## Maintenance rule

Update current guidance when setup, runtime topology, canonical routes, ownership, or deployment changes. Preserve historical evidence as-is; add a current document or index note instead of rewriting the old record.
