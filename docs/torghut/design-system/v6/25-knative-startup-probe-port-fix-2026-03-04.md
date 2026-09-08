# 25. Knative Probe Port Configuration Safety Fix for `torghut` (2026-03-04)

## Summary

Recent cluster rollout traces for `torghut` showed repeated startup/readiness instability with multiple `LatestCreatedFailed` and revision update retries. The most direct contributor identified in this run is a probe configuration drift: Knative startup probe currently points at `http1` rather than a numeric port, causing parse/type errors in the kubelet probe setup path.

This design proposal changes Knative probe port references in `argocd/applications/torghut/knative-service.yaml` so liveness/startup/readiness use `8181`, matching the container `http1` named port and avoiding string-to-int parsing failures.

## Evidence

- `pod/torghut-00049-deployment-676ccfbffb-tddjk` startup probe is rendered as `http://:http1/readyz` and produced `Startup probe errored and resulted in unknown state: strconv.Atoi: parsing "http1": invalid syntax`.
- Cluster events contain repeated revision churn and `LatestCreatedFailed` for `torghut-00049`, and transient readiness/liveness failures with mixed 503 and connection-timeout outcomes.
- `queue-proxy` readiness continues to use port `8012`, which is expected and unchanged.

## Design Decision

Set explicit numeric app ports on all Torghut probe settings in the Knative Service template:

- `livenessProbe.httpGet.port: 8181`
- `startupProbe.httpGet.port: 8181`
- `readinessProbe.httpGet.port: 8181`

Keep endpoint paths at current values (`/healthz`, `/readyz`) because those contracts already satisfy startup/readiness behavior expectations introduced in v6.

## Alternatives Considered

- Option A (selected): Use numeric app port `8181` for all three user-container probes.
  - Pros: minimal blast radius, direct compatibility with current manifest contract, and no image/runtime changes.
  - Cons: addresses only probe parsing/transport misconfiguration, not upstream dependency readiness behavior.
- Option B: Remove startup probe to avoid parser sensitivity and reduce startup fail-fast pressure.
  - Pros: eliminates startup parse-path failures.
  - Cons: masks legitimate cold-start dependency stalls and could increase MTTR during bad revisions.
- Option C: Rename/repurpose named port and switch all probes to name-based references with full queue-proxy validation.
  - Pros: improves human readability of manifest intent.
  - Cons: requires a broader rollout change and additional validation across revision templates.

## Tradeoffs and Rationale

- This change is deliberately narrow and safe: only probe transport values are modified, preserving probe logic and target endpoints.
- It complements existing readiness improvements already in source (`/readyz`, dependency checks, startup grace logic) rather than replacing them.
- The expected residual risk is low; if rollout instability continues after this fix, next-step candidates remain startup timeout thresholds and readiness dependency contracts.

## Rollback

- Revert only the three probe port values in `argocd/applications/torghut/knative-service.yaml`.
- No schema, code, or API contract change accompanies this patch; operational rollback is immediate through standard Argo/Knative sync behavior.
