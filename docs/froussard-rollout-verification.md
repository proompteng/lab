# Froussard rollout acceptance fixture

This temporary pull request verifies the deployed ready-review workflow introduced in #15696.
It requires real completed CI and Codex review evidence for this commit before Froussard may approve it.

Acceptance requires an `APPROVED` review from `tuslagch`, bound to this commit, containing the existing
`codex:ready` marker and `:shipit:` text. Replaying the readiness event must not create another approval.

This fixture is closed after verification; it is not intended to merge into main.
