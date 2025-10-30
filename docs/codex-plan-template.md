# Codex Plan Template

Use this structure whenever Codex (or reviewers) prepare a planning comment. The CLI automation in `apps/froussard/src/codex/cli/codex-plan.ts` enforces these sections and the ready checklist; keep the headings verbatim when updating tools or authoring manual plans.

```
<!-- codex:plan -->
### Objective
- One sentence describing the end goal in business/user terms.

### Context & Constraints
- Current state, linked files/services, feature flags, and explicit non-goals.

### Task Breakdown
1. Ordered steps with file paths, rationale, and pre/post conditions.

### Deliverables
- Expected artifacts (code, docs, dashboards, runbook updates, etc.).

### Validation & Observability
- Exact commands (lint/tests/build), runtime checks, telemetry, or manual QA.

### Risks & Contingencies
- Known pitfalls, blockers, fallback plans, or sequencing concerns.

### Communication & Handoff
- Stakeholders to notify, rollout/ops notes, or follow-up tickets.

### Ready Checklist
- [ ] Dependencies clarified (feature flags, secrets, linked services)
- [ ] Test and validation environments are accessible
- [ ] Required approvals/reviewers identified
- [ ] Rollback or mitigation steps documented
```

Document history:
- 30 Oct 2025 — Initial template aligned with Codex automation.
