# NetworkPolicy and RBAC Examples (torghut)

## NetworkPolicy (forwarder)
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: forwarder-egress
  namespace: torghut
spec:
  podSelector:
    matchLabels:
      app: alpaca-forwarder
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kafka}}
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: observability}}
        - ipBlock: {cidr: 0.0.0.0/0} # replace with Alpaca IP/CIDR or FQDN via egress gateway
      ports:
        - port: 443
          protocol: TCP
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: torghut}}
      ports:
        - port: 9093
          protocol: TCP
```
*(Adjust for Alpaca egress allowlist; replace ipBlock with egress gateway DNS policy if available.)*

## NetworkPolicy (Flink JM/TM)
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: flink-egress
  namespace: torghut
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: flink
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kafka}}
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: torghut}}
      ports:
        - port: 9093
          protocol: TCP
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: minio}}
      ports:
        - port: 9000
          protocol: TCP
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: observability}}
      ports:
        - port: 9090
          protocol: TCP
```

## RBAC (minimal forwarder)
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: alpaca-forwarder
  namespace: torghut
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: forwarder-basic
  namespace: torghut
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["configmaps", "secrets"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: forwarder-basic-binding
  namespace: torghut
subjects:
  - kind: ServiceAccount
    name: alpaca-forwarder
roleRef:
  kind: Role
  name: forwarder-basic
  apiGroup: rbac.authorization.k8s.io
```

## RBAC (Flink Operator already includes)
- Use Operator-installed roles; for the FlinkDeployment namespace, ensure the ServiceAccount used by JM/TM can read Secrets/ConfigMaps and list pods.

## Truststore mounts (Kafka/MinIO)
- Mount Strimzi-provided truststore secret and set:
  - `ssl.truststore.location=/etc/ssl/kafka/truststore.p12`
  - `ssl.truststore.password` from secret
  - `ssl.endpoint.identification.algorithm=HTTPS`
- If MinIO uses custom CA, mount it into `/etc/ssl/certs` and set `fs.s3a.connection.ssl.enabled=true`.
