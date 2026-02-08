# Argo CD / ApplicationSet Notes

> Note: Canonical production-facing design docs live in `docs/torghut/design-system/README.md` (v1). This document is supporting material and may drift from the current deployed manifests.

## WS app (example)
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: torghut-ws
spec:
  project: default
  source:
    repoURL: https://github.com/proompteng/lab.git
    targetRevision: HEAD
    path: argocd/applications/torghut/ws
  destination:
    namespace: torghut
    server: https://kubernetes.default.svc
  syncPolicy:
    automated: {prune: true, selfHeal: true}
    syncOptions: [CreateNamespace=true]
```

## Flink TA app
Similar shape, path `argocd/applications/torghut/flink-ta`. Ensure sync wave runs after operator if same namespace.

## ApplicationSet hook
- Add entries for forwarder and flink-ta in `applicationsets/product.yaml` (per issue #1914 and #1915).
- Use generator fields (e.g., cluster list or repo path) consistent with existing Product ApplicationSet.

## Sync order
- Operator (if separate app) → kotlin-ws → flink-ta. Use sync waves/weights if needed.

## Namespaces
- torghut: forwarder, flink-ta runtime.
- kafka: Strimzi cluster and KafkaUser source secrets (reflected into torghut as needed).
- minio/observability: MinIO and Mimir/Loki/Tempo; ensure NetworkPolicies allow required egress.
