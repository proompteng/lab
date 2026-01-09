---
name: Codex Task
about: Request a Codex implementation run for lab
title: ''
labels: ['codex']
assignees: ''
---

## Summary
<!-- One paragraph: what needs to change and why now. Include key links. -->

## Codex Metadata (Optional)
<!--
This block configures Codex behavior from the GitHub issue body.
Only the keys below are currently parsed. Unknown keys are ignored.
-->
```codex
version: 1
autonomous: false # true to force autonomous pipeline
iterations:
  mode: fixed # fixed | until | budget | adaptive
  count: 1 # default 1, max 25
  min: 1
  max: 5
  stop_on:
    - success
    - needs_human
  reason: "optional rationale"
```
<!--
Notes:
- You can also set iterations as a scalar: `iterations: 3` or `iteration: 3`.
- `pipeline: autonomous` is also accepted as a shorthand for autonomous mode.
-->

## Context
<!-- Current behavior, relevant files/services, and prior art. Link to docs, runbooks, or related PRs. -->

## Desired Outcome
<!-- Concrete end state (behavior, UX, infra state). -->

## Scope
- In scope:
  - <!-- Directories/codepaths Codex may touch (e.g., services/facteur/**). -->
- Out of scope:
  - <!-- Explicitly list items that must NOT change (e.g., prod config, infra, migrations). -->

## Constraints & Risks
<!-- Hard constraints (security, performance, deadlines), known risks, or required approvals. -->

## Rollout / Ops Notes
<!-- Describe deployment sequencing, Argo workflow triggers, or coordination needed with other teams. Mention feature flags or toggles. -->

## Validation
- [ ] <!-- Command(s) + expected outcome. -->
- [ ] <!-- Add all required checks (lint, tests, smoke, docs). -->

## Codex Prompt
<!-- Provide the exact prompt Codex should use. Be explicit about scope and output format. -->
<!--
Instructions: replace each condition below with a concrete, testable requirement.
- do not stop until condition 1
- do not stop until condition 2
- do not stop until condition 3
- do not stop until condition 4
- do not stop until condition 5
-->

## Additional Context
<!-- Logs, screenshots, Argo workflow runs, or Discord threads that provide extra colour. -->
