# NetworkPolicy and RBAC Examples (torghut)

> Note: Canonical source-of-truth documents are in `docs/torghut/design-system/README.md` and `docs/torghut/design-system/v1/security-network-and-rbac.md`.

## Production manifests (current GitOps baseline)

- `argocd/applications/torghut/networkpolicy-common-dns-egress.yaml`
- `argocd/applications/torghut/networkpolicy-ta-egress.yaml`
- `argocd/applications/torghut/networkpolicy-ta-ingress-metrics.yaml`
- `argocd/applications/torghut/networkpolicy-ws-egress.yaml`
- `argocd/applications/torghut/networkpolicy-ws-ingress-metrics.yaml`
- `argocd/applications/torghut/networkpolicy-lean-runner-ingress.yaml`
- `argocd/applications/torghut/networkpolicy-service-ingress.yaml`
- `argocd/applications/torghut/networkpolicy-lean-runner-egress.yaml`
- `argocd/applications/torghut/networkpolicy-service-egress.yaml`
- `argocd/applications/torghut/networkpolicy-llm-guardrails-exporter-egress.yaml`
- `argocd/applications/torghut/networkpolicy-llm-guardrails-exporter-ingress-metrics.yaml`
- `argocd/applications/torghut/networkpolicy-clickhouse-guardrails-exporter-egress.yaml`
- `argocd/applications/torghut/networkpolicy-clickhouse-guardrails-exporter-ingress-metrics.yaml`
- `argocd/applications/torghut/role.yaml`

## Policy notes

- DNS egress is explicitly allowed for all Torghut workloads to `kube-system` (`k8s-app: kube-dns`).
- `torghut-ws` is restricted to Kafka (9092) plus external HTTPS egress for broker/websocket endpoints.
- Flink TA is restricted to Kafka, Kafka schema registry, ClickHouse, and the Ceph RGW endpoint used by the runtime.
- `torghut` service ingress is constrained to trusted in-namespace callers on port `8181`, and egress is additionally constrained to:
  - execution callbacks endpoint (`torghut-lean-runner:8088`)
  - Ceph RGW (`rook-ceph`:80/443) for whitepaper storage
  - HTTPS API calls on `443` for external dependencies.
- `torghut-lean-runner` ingress is constrained to calls from the trading service (`torghut`) on port `8088`.
- Observability-to-runtime ingress is now explicit: Alloy scrape traffic is only allowed to `ta` (`9249`) and `ws` (`9090`) metric ports.
- Guardrails exporter flows are now explicitly constrained:
  - `torghut-llm-guardrails-exporter` can scrape `torghut` on port `8181` and expose `9110`.
  - `torghut-clickhouse-guardrails-exporter` can scrape ClickHouse on port `8123` and expose `9108`.
- The shared `torghut-runtime` service account is now set to zero pod privileges:
  - `rules: []` (no in-cluster control-plane access)

## Rollout checklist

- Keep all changes under `argocd/applications/torghut/**` and apply through ArgoCD sync.
- Validate RBAC/NetworkPolicy via:
  - `kubectl -n torghut auth can-i get pods --as=system:serviceaccount:torghut:torghut-runtime` (must be denied)
  - `kubectl -n torghut auth can-i get pods/log --as=system:serviceaccount:torghut:torghut-runtime` (must be denied)
  - `kubectl -n torghut auth can-i create pods --as=system:serviceaccount:torghut:torghut-runtime` (must be denied)
  - `kubectl -n torghut auth can-i get namespaces --as=system:serviceaccount:torghut:torghut-runtime` (must be denied)
  - `kubectl -n torghut get networkpolicy`
  - `kubectl -n torghut get networkpolicy torghut-ta-egress torghut-ta-ingress-metrics torghut-ws-egress torghut-ws-ingress-metrics torghut-lean-runner-egress torghut-lean-runner-ingress torghut-service-egress torghut-service-ingress`
- Validate rollout:
  - `kubectl -n torghut rollout status deploy/torghut-ws`
  - `kubectl -n torghut rollout status deploy/torghut-lean-runner`
  - `kubectl -n torghut get flinkdeployment torghut-ta`
  - `kubectl -n torghut get pods -l serving.knative.dev/service=torghut --show-labels`
  - `kubectl -n torghut get pods -l app=torghut-ws -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type==\"Ready\")].status`
  - `kubectl -n torghut get pods -l app.kubernetes.io/name=torghut-llm-guardrails-exporter -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type==\"Ready\")].status`
  - `kubectl -n torghut get pods -l app.kubernetes.io/name=torghut-clickhouse-guardrails-exporter -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type==\"Ready\")].status`
  - app health checks for `/healthz` endpoints as part of existing runbooks
  - `kubectl -n torghut auth can-i create pods --as=system:serviceaccount:torghut:torghut-runtime` (must be denied)
  - `kubectl -n torghut get networkpolicy -o yaml | sha256sum` (record pre/post)
  - `kubectl -n torghut get role,rolebinding torghut-runtime -o yaml | sha256sum` (record pre/post)

### Iteration documentation requirement

- For every policy or RBAC change, add a non-committed note at `${artifactPath}/notes/iteration-<n>.md` with pre-check, post-check, and rollback results.
