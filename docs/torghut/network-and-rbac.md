# NetworkPolicy and RBAC Examples (torghut)

> Note: Canonical source-of-truth documents are in `docs/torghut/design-system/README.md` and `docs/torghut/design-system/v1/security-network-and-rbac.md`.

## Production manifests (current GitOps baseline)

- `argocd/applications/torghut/networkpolicy-common-dns-egress.yaml`
- `argocd/applications/torghut/networkpolicy-ta-egress.yaml`
- `argocd/applications/torghut/networkpolicy-ta-ingress-metrics.yaml`
- `argocd/applications/torghut/networkpolicy-ws-egress.yaml`
- `argocd/applications/torghut/networkpolicy-ws-ingress-metrics.yaml`
- `argocd/applications/torghut/networkpolicy-lean-runner-egress.yaml`
- `argocd/applications/torghut/networkpolicy-service-egress.yaml`
- `argocd/applications/torghut/role.yaml`

## Policy notes

- DNS egress is explicitly allowed for all Torghut workloads to `kube-system` (`k8s-app: kube-dns`).
- `torghut-ws` is restricted to Kafka (9092) plus external HTTPS egress for broker/websocket endpoints.
- Flink TA is restricted to Kafka, Kafka schema registry, ClickHouse, and the Ceph RGW endpoint used by the runtime.
- `torghut` service egress is additionally constrained to the execution callbacks endpoint (`torghut-lean-runner:8088`) and Ceph RGW (`rook-ceph`:80/443) for whitepaper storage.
- Observability-to-runtime ingress is now explicit: Alloy scrape traffic is only allowed to `ta` (`9249`) and `ws` (`9090`) metric ports.
- The shared `torghut-runtime` service account is now limited to pod-read-only diagnostics:
  - `get` on `pods`
  - `get` on `pods/log`

## Rollout checklist

- Keep all changes under `argocd/applications/torghut/**` and apply through ArgoCD sync.
- Validate RBAC/NetworkPolicy via:
  - `kubectl -n torghut auth can-i get pods --as=system:serviceaccount:torghut:torghut-runtime`
  - `kubectl -n torghut auth can-i get pods/log --as=system:serviceaccount:torghut:torghut-runtime`
  - `kubectl -n torghut auth can-i create pods --as=system:serviceaccount:torghut:torghut-runtime` (expect denied)
  - `kubectl -n torghut auth can-i list pods --as=system:serviceaccount:torghut:torghut-runtime` (expect denied)
  - `kubectl -n torghut get networkpolicy`
- Validate rollout:
  - `kubectl -n torghut rollout status deploy/torghut-ws`
  - `kubectl -n torghut rollout status deploy/torghut-lean-runner`
  - `kubectl -n torghut get flinkdeployment torghut-ta`
  - `kubectl -n torghut get pods -l serving.knative.dev/service=torghut --show-labels`
  - `kubectl -n torghut get pods -l app=torghut-ws -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type==\"Ready\")].status`
  - app health checks for `/healthz` endpoints as part of existing runbooks
