---
name: Codex Task
about: Spin up a Codex-assisted plan and implementation workflow for lab
title: ''
labels: ['codex']
assignees: ''
---

## Summary
<!-- One-paragraph problem statement and why we need Codex support now. Reference impacted product areas and link to relevant docs. -->

## Current State
<!-- What exists today? Call out files, services, or runbooks that show the present behaviour or gaps. -->

## Desired Outcome
<!-- Enumerate the end state we expect once Codex finishes (behaviour changes, UX updates, infra state, etc.). -->

## Scope Guardrails
- In scope:
  - <!-- List the directories/codepaths Codex may touch (e.g., packages/temporal-bun-sdk/src/worker/**) -->
- Out of scope:
  - <!-- Explicitly list items that must NOT change (e.g., Terraform, prod config, worker rollout). -->

## Acceptance Criteria
<!-- Bullet list of objective checks. Include tests, docs, telemetry, and rollout expectations. -->

## Dependencies / Related Work
- Blocking issues: <!-- #1604, #1612, etc. -->
- Follow-up items: <!-- Optional downstream clean-up or monitoring stories. -->

## Validation Checklist
- [ ] <!-- e.g., `pnpm --filter @proompteng/temporal-bun-sdk exec bun test packages/...` -->
- [ ] <!-- Add all required commands or manual verifications. -->

## Rollout / Ops Notes
<!-- Describe deployment sequencing, Argo workflow triggers, or coordination needed with other teams. Mention feature flags or toggles. -->

## Codex Prompt
<!-- Provide the exact prompt Codex should use when running the planning workflow. Include any specific constraints or context payload. -->

<details>
<summary>Automation</summary>

- Set `CODEX_STAGE` to one of:
  - `planning` (generate plan only)
  - `implementation` (execute approved plan)
- The Codex GitHub comment must contain a `<!-- codex:plan -->` block mirroring the acceptance criteria and validation tables before implementation can start.
- Implementation updates should append to the progress comment managed by `apps/froussard/src/codex/cli/codex-progress-comment.ts`.

</details>

## Additional Context
<!-- Logs, screenshots, Argo workflow runs, or Discord threads that provide extra colour. -->
