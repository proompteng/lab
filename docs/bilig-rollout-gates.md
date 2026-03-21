# `bilig` Rollout Gates

## Gate set

- image build succeeds
- application health checks pass
- product browser acceptance remains green
- formula acceptance remains green on the shipping SHA
- release size budgets remain inside the declared ceiling
- no rollout proceeds on a SHA with open formula acceptance regressions

## Top 100-specific rule

If a formula family is promoted to WASM production mode in `bilig`, rollout must use the same SHA for:

- product app
- sync/runtime services
- observability labels and dashboards

## Ownership

- `bilig` defines product acceptance
- `lab` enforces rollout progression and rollback policy
