#!/usr/bin/env bash

set -euo pipefail

readonly hermes_image='registry.ide-newton.ts.net/lab/hermes-agent@sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a'
probe_namespace="hermes-network-policy-probe-$(openssl rand -hex 4)"
readonly probe_namespace
probe_namespace_created=false

cleanup_probe() {
  if [[ "$probe_namespace_created" == true ]]; then
    kubectl -n default delete namespace "$probe_namespace" --ignore-not-found --wait=true --timeout=5m >/dev/null
    probe_namespace_created=false
  fi
}

abort_probe() {
  trap - EXIT HUP INT TERM
  cleanup_probe
  exit 130
}

trap cleanup_probe EXIT
trap abort_probe HUP INT TERM

kubectl -n default create namespace "$probe_namespace" >/dev/null
probe_namespace_created=true
kubectl -n default label namespace "$probe_namespace" --overwrite \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted >/dev/null

sed "s|HERMES_IMAGE|$hermes_image|g" <<'EOF' | kubectl -n "$probe_namespace" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: policy-server
  labels:
    app.kubernetes.io/name: hermes-network-policy-probe
    app.kubernetes.io/component: server
spec:
  activeDeadlineSeconds: 600
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: hermes-network-policy-probe
          topologyKey: kubernetes.io/hostname
  automountServiceAccountToken: false
  enableServiceLinks: false
  nodeSelector:
    kubernetes.io/arch: amd64
  restartPolicy: Never
  terminationGracePeriodSeconds: 5
  securityContext:
    runAsNonRoot: true
    runAsUser: 10000
    runAsGroup: 10000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: server
      image: HERMES_IMAGE
      imagePullPolicy: IfNotPresent
      command:
        - /opt/hermes/.venv/bin/python
        - -m
        - http.server
        - "8080"
        - --bind
        - 0.0.0.0
      env:
        - name: HOME
          value: /tmp
        - name: PYTHONDONTWRITEBYTECODE
          value: "1"
      ports:
        - name: http
          containerPort: 8080
      readinessProbe:
        tcpSocket:
          port: http
        periodSeconds: 1
        failureThreshold: 30
      resources:
        requests:
          cpu: 10m
          memory: 32Mi
          ephemeral-storage: 16Mi
        limits:
          cpu: 250m
          memory: 128Mi
          ephemeral-storage: 128Mi
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 10000
        runAsGroup: 10000
      volumeMounts:
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tmp
      emptyDir:
        sizeLimit: 16Mi
---
apiVersion: v1
kind: Pod
metadata:
  name: policy-client
  labels:
    app.kubernetes.io/name: hermes-network-policy-probe
    app.kubernetes.io/component: client
spec:
  activeDeadlineSeconds: 600
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: hermes-network-policy-probe
          topologyKey: kubernetes.io/hostname
  automountServiceAccountToken: false
  enableServiceLinks: false
  nodeSelector:
    kubernetes.io/arch: amd64
  restartPolicy: Never
  terminationGracePeriodSeconds: 5
  securityContext:
    runAsNonRoot: true
    runAsUser: 10000
    runAsGroup: 10000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: client
      image: HERMES_IMAGE
      imagePullPolicy: IfNotPresent
      command:
        - /bin/sh
        - -c
        - while :; do sleep 3600; done
      env:
        - name: HOME
          value: /tmp
        - name: PYTHONDONTWRITEBYTECODE
          value: "1"
      resources:
        requests:
          cpu: 10m
          memory: 32Mi
          ephemeral-storage: 16Mi
        limits:
          cpu: 250m
          memory: 128Mi
          ephemeral-storage: 128Mi
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 10000
        runAsGroup: 10000
      volumeMounts:
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tmp
      emptyDir:
        sizeLimit: 16Mi
EOF

kubectl -n "$probe_namespace" wait pod/policy-server pod/policy-client --for=condition=Ready --timeout=5m >/dev/null
server_ip=$(kubectl -n "$probe_namespace" get pod policy-server -o jsonpath='{.status.podIP}')
test -n "$server_ip"

probe_request() {
  kubectl -n "$probe_namespace" exec pod/policy-client -c client -- \
    /opt/hermes/.venv/bin/python -c \
    'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2).read(1)' \
    "http://$server_ip:8080/" >/dev/null 2>&1
}

baseline_reachable=false
for _ in $(seq 1 30); do
  if probe_request; then
    baseline_reachable=true
    break
  fi
  sleep 1
done
if [[ "$baseline_reachable" != true ]]; then
  kubectl -n "$probe_namespace" logs pod/policy-server -c server >&2 || true
  echo 'network-policy probe could not establish baseline Pod-to-Pod connectivity' >&2
  exit 1
fi

kubectl -n "$probe_namespace" apply -f - >/dev/null <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-client-egress
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: hermes-network-policy-probe
      app.kubernetes.io/component: client
  policyTypes:
    - Egress
  egress: []
EOF

policy_enforced=false
for _ in $(seq 1 30); do
  if ! probe_request; then
    policy_enforced=true
    break
  fi
  sleep 1
done
if [[ "$policy_enforced" != true ]]; then
  echo 'NetworkPolicy is not enforced; do not sync Hermes' >&2
  exit 1
fi

printf 'network_policy_enforced=true\n'
cleanup_probe
trap - EXIT HUP INT TERM
