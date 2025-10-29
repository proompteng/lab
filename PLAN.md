<!-- codex:plan -->
### Summary
- Capture a lightweight documentation entry that records the Codex planning prompt test for issue #1617 while keeping the repo state clean and reviewable.

### Steps
- `git status --short` (workdir: `/workspace/lab`, expect no output) to confirm the working tree is clean before creating the feature branch.
- `git switch -c codex/issue-1617-d55bf49a origin/main` (workdir: `/workspace/lab`, expect "Switched to a new branch 'codex/issue-1617-d55bf49a'") to branch from the latest `main`.
- Add `docs/codex-planning-prompt.md` with a short note titled "Codex Planning Prompt Test" that summarizes the issue context, reiterates the acceptance criteria, and links to https://github.com/proompteng/lab/issues/1617 so reviewers understand why the doc exists.
- `pnpm exec biome check docs/codex-planning-prompt.md` (workdir: `/workspace/lab`, expect "No diagnostics found") to satisfy the repository formatting policy for Markdown additions.
- `git add docs/codex-planning-prompt.md PLAN.md && git commit -m "docs: add codex planning prompt note"` (workdir: `/workspace/lab`, expect a single-commit summary) to capture the documentation update alongside this plan artifact.
- `git status --short` (workdir: `/workspace/lab`, expect no output) to verify the branch is ready for review after the commit.

### Validation
- `pnpm exec biome check docs/codex-planning-prompt.md` (workdir: `/workspace/lab`) returns "No diagnostics found".
- `git status --short` (workdir: `/workspace/lab`) shows a clean tree once the commit is created.
- Manually confirm `docs/codex-planning-prompt.md` includes the issue link and acceptance criteria language requested above.

### Risks
- Documentation could go stale if planning guidance changes again; flag reviewers so the doc can be updated or removed later.
- Missing the Biome check would block CI; ensure the command is run locally before pushing.

### Handoff Notes
- Branch to push: `codex/issue-1617-d55bf49a` rooted at `origin/main`.
- New documentation lives at `docs/codex-planning-prompt.md`; no builds or migrations are needed.
- PLAN.md already contains this plan; keep it in sync if edits are made before opening a PR.
