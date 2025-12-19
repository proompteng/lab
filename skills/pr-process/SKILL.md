---
name: pr-process
description: Follow the repo’s PR and commit conventions.
---

## Commits
- Use Conventional Commits with approved types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

## PRs
- Use the default template in `.github/PULL_REQUEST_TEMPLATE.md`.
- Fill Summary, Related Issues, Testing, Screenshots/None, Breaking Changes/None, Checklist.
- Use `gh pr create --body-file /tmp/pr.md`; wrap markdown in single quotes or use `--body-file`.
- Merge with squash: `gh pr merge <number> --squash --delete-branch`.
