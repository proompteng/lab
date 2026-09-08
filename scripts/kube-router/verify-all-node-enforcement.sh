#!/usr/bin/env bash

set -euo pipefail

readonly probe_image='docker.io/cloudnativelabs/kube-router@sha256:0991f2cc7aaabe107b51c0c554d6b843f0483fd319b94f437fab638470c47c22'
probe_namespace="kube-router-network-policy-probe-$(openssl rand -hex 4)"
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

linux_nodes=$(
  kubectl get nodes -l kubernetes.io/os=linux -o json |
    jq -r '.items | sort_by(.metadata.name)[] | .metadata.name'
)
linux_node_count=$(wc -l <<< "$linux_nodes" | tr -d '[:space:]')
test "$linux_node_count" -gt 1
kubectl get nodes -l kubernetes.io/os=linux -o json |
  jq -e 'all(.items[]; any(.status.conditions[]; .type == "Ready" and .status == "True"))' >/dev/null

probe_index=0
while IFS= read -r probe_node; do
  sed \
    -e "s|PROBE_IMAGE|$probe_image|g" \
    -e "s|PROBE_NODE|$probe_node|g" \
    -e "s|PROBE_INDEX|$probe_index|g" <<'EOF' | kubectl -n "$probe_namespace" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: policy-server-PROBE_INDEX
  labels:
    app.kubernetes.io/name: kube-router-network-policy-probe
    app.kubernetes.io/component: server
spec:
  activeDeadlineSeconds: 900
  automountServiceAccountToken: false
  enableServiceLinks: false
  nodeName: PROBE_NODE
  tolerations:
    - operator: Exists
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
      image: PROBE_IMAGE
      imagePullPolicy: IfNotPresent
      command:
        - /bin/busybox
        - nc
        - -lk
        - -p
        - "8080"
        - -e
        - /bin/cat
      ports:
        - name: tcp
          containerPort: 8080
      readinessProbe:
        tcpSocket:
          port: tcp
        periodSeconds: 1
        failureThreshold: 30
      resources:
        requests:
          cpu: 5m
          memory: 8Mi
          ephemeral-storage: 8Mi
        limits:
          cpu: 100m
          memory: 32Mi
          ephemeral-storage: 32Mi
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
        readOnlyRootFilesystem: true
---
apiVersion: v1
kind: Pod
metadata:
  name: policy-client-PROBE_INDEX
  labels:
    app.kubernetes.io/name: kube-router-network-policy-probe
    app.kubernetes.io/component: client
spec:
  activeDeadlineSeconds: 900
  automountServiceAccountToken: false
  enableServiceLinks: false
  nodeName: PROBE_NODE
  tolerations:
    - operator: Exists
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
      image: PROBE_IMAGE
      imagePullPolicy: IfNotPresent
      command:
        - /bin/sleep
        - "900"
      resources:
        requests:
          cpu: 5m
          memory: 8Mi
          ephemeral-storage: 8Mi
        limits:
          cpu: 100m
          memory: 32Mi
          ephemeral-storage: 32Mi
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
        readOnlyRootFilesystem: true
EOF
  probe_index=$((probe_index + 1))
done <<< "$linux_nodes"

kubectl -n "$probe_namespace" wait pod -l app.kubernetes.io/component=server \
  --for=condition=Ready --timeout=5m >/dev/null
kubectl -n "$probe_namespace" wait pod -l app.kubernetes.io/component=client \
  --for=condition=Ready --timeout=5m >/dev/null

client_count=$(
  kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=client -o name |
    wc -l |
    tr -d '[:space:]'
)
server_count=$(
  kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=server -o name |
    wc -l |
    tr -d '[:space:]'
)
test "$client_count" = "$linux_node_count"
test "$server_count" = "$linux_node_count"

cross_node_server_ip() {
  local client_pod=$1
  local client_node
  local server_ip

  client_node=$(kubectl -n "$probe_namespace" get "$client_pod" -o jsonpath='{.spec.nodeName}')
  server_ip=$(
    kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=server -o json |
      jq -r --arg client_node "$client_node" \
        '[.items[] | select(.status.phase == "Running")] | sort_by(.spec.nodeName) as $servers |
        ($servers | map(.spec.nodeName) | index($client_node)) as $client_index |
        if $client_index == null or ($servers | length) < 2 then
          empty
        else
          $servers[(($client_index + 1) % ($servers | length))].status.podIP
        end'
  )
  test -n "$server_ip"
  printf '%s\n' "$server_ip"
}

probe_request() {
  local client_pod=$1
  local server_ip=$2

  # The single-quoted program expands inside the probe container, not in the operator shell.
  # shellcheck disable=SC2016
  kubectl -n "$probe_namespace" exec "$client_pod" -c client -- /bin/sh -ec '
    /bin/busybox nc -z -w 2 "$1" 8080 && exit 0
    status=$?
    if [ "$status" -eq 1 ]; then
      exit 42
    fi
    exit 43
  ' probe "$server_ip" >/dev/null 2>&1
}

verify_probe_health() {
  kubectl -n "$probe_namespace" wait pod -l app.kubernetes.io/component=server \
    --for=condition=Ready --timeout=10s >/dev/null
  kubectl -n "$probe_namespace" wait pod -l app.kubernetes.io/component=client \
    --for=condition=Ready --timeout=10s >/dev/null
  while IFS= read -r server_pod; do
    kubectl -n "$probe_namespace" exec "$server_pod" -c server -- \
      /bin/busybox nc -z -w 2 127.0.0.1 8080 >/dev/null 2>&1
  done < <(kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=server -o name)
}

while IFS= read -r client_pod; do
  server_ip=$(cross_node_server_ip "$client_pod")
  baseline_reachable=false
  for _ in $(seq 1 30); do
    if probe_request "$client_pod" "$server_ip"; then
      baseline_reachable=true
      break
    else
      request_status=$?
    fi
    if [[ "$request_status" -ne 42 ]]; then
      echo "baseline probe execution failed from $client_pod with status $request_status" >&2
      exit 1
    fi
    sleep 1
  done
  if [[ "$baseline_reachable" != true ]]; then
    echo "cross-node baseline connectivity failed from $client_pod" >&2
    exit 1
  fi
done < <(kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=client -o name)

kubectl -n "$probe_namespace" apply -f - >/dev/null <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-client-egress
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: kube-router-network-policy-probe
      app.kubernetes.io/component: client
  policyTypes:
    - Egress
  egress: []
EOF

while IFS= read -r client_pod; do
  server_ip=$(cross_node_server_ip "$client_pod")
  policy_enforced=false
  for _ in $(seq 1 60); do
    if probe_request "$client_pod" "$server_ip"; then
      sleep 1
      continue
    else
      request_status=$?
    fi
    if [[ "$request_status" -eq 42 ]]; then
      verify_probe_health
      policy_enforced=true
      break
    fi
    echo "denial probe execution failed from $client_pod with status $request_status" >&2
    exit 1
  done
  if [[ "$policy_enforced" != true ]]; then
    client_node=$(kubectl -n "$probe_namespace" get "$client_pod" -o jsonpath='{.spec.nodeName}')
    echo "NetworkPolicy is not enforced on node $client_node" >&2
    exit 1
  fi
done < <(kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=client -o name)

kubectl -n "$probe_namespace" delete networkpolicy deny-client-egress --wait=true --timeout=1m >/dev/null
while IFS= read -r client_pod; do
  server_ip=$(cross_node_server_ip "$client_pod")
  policy_released=false
  for _ in $(seq 1 60); do
    if probe_request "$client_pod" "$server_ip"; then
      policy_released=true
      break
    else
      request_status=$?
    fi
    if [[ "$request_status" -ne 42 ]]; then
      echo "release probe execution failed from $client_pod with status $request_status" >&2
      exit 1
    fi
    sleep 1
  done
  if [[ "$policy_released" != true ]]; then
    client_node=$(kubectl -n "$probe_namespace" get "$client_pod" -o jsonpath='{.spec.nodeName}')
    echo "NetworkPolicy removal did not restore connectivity on node $client_node" >&2
    exit 1
  fi
done < <(kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=client -o name)

kubectl -n "$probe_namespace" apply -f - >/dev/null <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-server-ingress
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: kube-router-network-policy-probe
      app.kubernetes.io/component: server
  policyTypes:
    - Ingress
  ingress: []
EOF

while IFS= read -r client_pod; do
  server_ip=$(cross_node_server_ip "$client_pod")
  policy_enforced=false
  for _ in $(seq 1 60); do
    if probe_request "$client_pod" "$server_ip"; then
      sleep 1
      continue
    else
      request_status=$?
    fi
    if [[ "$request_status" -eq 42 ]]; then
      verify_probe_health
      policy_enforced=true
      break
    fi
    echo "ingress denial probe execution failed from $client_pod with status $request_status" >&2
    exit 1
  done
  if [[ "$policy_enforced" != true ]]; then
    server_node=$(
      kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=server -o json |
        jq -r --arg server_ip "$server_ip" '.items[] | select(.status.podIP == $server_ip) | .spec.nodeName'
    )
    echo "NetworkPolicy ingress is not enforced on node $server_node" >&2
    exit 1
  fi
done < <(kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=client -o name)

kubectl -n "$probe_namespace" delete networkpolicy deny-server-ingress --wait=true --timeout=1m >/dev/null
while IFS= read -r client_pod; do
  server_ip=$(cross_node_server_ip "$client_pod")
  policy_released=false
  for _ in $(seq 1 60); do
    if probe_request "$client_pod" "$server_ip"; then
      policy_released=true
      break
    else
      request_status=$?
    fi
    if [[ "$request_status" -ne 42 ]]; then
      echo "ingress release probe execution failed from $client_pod with status $request_status" >&2
      exit 1
    fi
    sleep 1
  done
  if [[ "$policy_released" != true ]]; then
    server_node=$(
      kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=server -o json |
        jq -r --arg server_ip "$server_ip" '.items[] | select(.status.podIP == $server_ip) | .spec.nodeName'
    )
    echo "NetworkPolicy ingress removal did not restore connectivity on node $server_node" >&2
    exit 1
  fi
done < <(kubectl -n "$probe_namespace" get pods -l app.kubernetes.io/component=client -o name)

printf 'network_policy_ingress_and_egress_enforced_on_all_linux_nodes=true nodes=%s\n' "$linux_node_count"
cleanup_probe
trap - EXIT HUP INT TERM
