# NetworkPolicy and RBAC Examples (torghut)

> Note: Canonical source-of-truth documents are in `docs/torghut/design-system/README.md` and `docs/torghut/design-system/v1/security-network-and-rbac.md`.

## Production manifests (current GitOps baseline)

- `argocd/applications/torghut/networkpolicy-common-dns-egress.yaml`
- `argocd/applications/torghut/networkpolicy-ta-egress.yaml`
- `argocd/applications/torghut/networkpolicy-ws-egress.yaml`
- `argocd/applications/torghut/networkpolicy-lean-runner-egress.yaml`
- `argocd/applications/torghut/networkpolicy-service-egress.yaml`
- `argocd/applications/torghut/role.yaml`

## Policy notes

- DNS egress is explicitly allowed for all Torghut workloads to `kube-system` (`k8s-app: kube-dns`).
- `torghut-ws` is restricted to Kafka (9092) plus external HTTPS egress for broker/websocket endpoints.
- Flink TA is restricted to Kafka, Kafka schema registry, ClickHouse, and the Ceph RGW endpoint used by the runtime.
- The shared `torghut-runtime` service account is now limited to Pod diagnostics read verbs only (`get`, `list`, `watch` on `pods` + `pods/log`).
- `torghut` service egress is constrained to namespace peers for Postgres/ClickHouse/features/agents/Jangar/Inngest/Saigak and Kafka.

## Rollout checklist

- Keep all changes under `argocd/applications/torghut/**` and apply through ArgoCD sync.
- Validate RBAC/NetworkPolicy via:
  - `kubectl -n torghut auth can-i get pods --as=system:serviceaccount:torghut:torghut-runtime`
  - `kubectl -n torghut auth can-i create pods --as=system:serviceaccount:torghut:torghut-runtime` (expect denied)
  - `kubectl -n torghut get networkpolicy`
- Validate rollout:
  - `kubectl -n torghut rollout status deploy/torghut-ws`
  - `kubectl -n torghut rollout status deploy/torghut-lean-runner`
  - `kubectl -n torghut get flinkdeployment torghut-ta`
  - app health checks for `/healthz` endpoints as part of existing runbooks
