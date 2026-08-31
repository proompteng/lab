# 24. Knative Probe Port Normalization for Rollout Stability (2026-03-04)

## Summary

A recurring rollout instability for `torghut` was traced to a control-plane parsing failure in readiness/startup probe handling when probes reference the Knative container port by name (`http1`) instead of numeric port. This proposal standardizes probe target transport to the numeric container port (`8181`) for liveness, startup, and readiness probes in `argocd/applications/torghut/knative-service.yaml` while keeping existing probe paths unchanged.

## Evidence

- `kubectl get pods -n torghut -o wide` during rollout shows multiple revisions with mixed readiness states and at least one new revision failing to stabilize.
- Pod and event logs include startup parser errors: `strconv.Atoi: parsing "http1": invalid syntax`.
- Readiness/liveness probe failures repeatedly target `/healthz` and `/readyz` on `http` and `http1` references.
- Source side already exposes both probe endpoints:
  - `services/torghut/app/main.py` provides `/healthz` and `/readyz`.
- Database/readiness checks already include schema and account-scope diagnostics in `services/torghut/app/db.py` and `/readyz` dependencies.

## Decision

Use numeric port references for all probes in Knative service spec:

- `livenessProbe.httpGet.port: 8181`
- `startupProbe.httpGet.port: 8181`
- `readinessProbe.httpGet.port: 8181`

Keep probe paths and timing as-is to minimize blast radius and avoid contract drift:

- liveness: `/healthz`
- startup and readiness: `/readyz`

## Alternatives considered

- Option A (Selected): Keep paths and switch only probe transport to numeric `8181`.
  - Pros: minimal change, directly addresses `strconv.Atoi` failure mode, preserves endpoint semantics and all alerting thresholds.
  - Cons: does not address any unrelated dependency or startup timeout root causes.
- Option B: Keep `http1` and change startup/readiness paths only.
  - Pros: avoids touching transport semantics.
  - Cons: does not resolve the parse error and fails to address the observed startup probe failure mechanism.
- Option C: Replace readiness/liveness paths and add service-level wrappers.
  - Pros: can create more semantic probe responses.
  - Cons: larger behavior change with higher rollout risk.

## Tradeoffs and risks

- This is intentionally narrow and low-risk; rollback is a single manifest revert.
- If startup flaps persist, the remaining likely causes are dependency warm-up timing, external dependency health, or startup timeout values; those can be treated in follow-up design work.
- The change does not alter readiness dependency contract logic or DB validation behavior.

## Implementation and rollout

1. Update `argocd/applications/torghut/knative-service.yaml` probe `port` values from `http1` to `8181`.
2. Run `bun run lint:argocd`.
3. Submit PR and wait for rollout checks.
4. Monitor new revision rollout for elimination of `strconv.Atoi` startup errors.

## Validation criteria

- New revision startup logs do not include `strconv.Atoi: parsing "http1": invalid syntax`.
- Ready/liveness health endpoints continue returning expected semantics.
- `LatestReadyUpdate` succeeds for the next torghut revision without startup-probe parse exceptions.

## Rollback

Revert `argocd/applications/torghut/knative-service.yaml` probe `port` fields to `http1`.
