#!/usr/bin/env bash

set -euo pipefail

readonly KUBE_CONTEXT='galactic-lan'
readonly NAMESPACE='kata'
readonly RETIRED_NAMESPACE='microvm-system'
readonly NANOAGENT_IMAGE='ghcr.io/proompteng/nanoagent@sha256:78b7b6e52e9b3f6003d2663a5e85fbfb55eabba018a6ee61f6b39a722f71ad7c'

usage() {
  echo "usage: $0 <absolute-evidence-directory> [kubernetes-node] [qemu|clh|fc|dragonball]" >&2
}

node_address() {
  case "$1" in
    talos-192-168-1-194) echo '100.100.244.141' ;;
    turin) echo '100.100.244.190' ;;
    talos-192-168-1-85) echo '100.100.244.142' ;;
    *) return 1 ;;
  esac
}

runtime_class_for_vmm() {
  case "$1" in
    qemu) echo 'kata-qemu' ;;
    clh) echo 'kata-clh' ;;
    fc) echo 'kata-fc' ;;
    dragonball) echo 'kata-dragonball' ;;
    *) return 1 ;;
  esac
}

if [[ $# -lt 1 || $# -gt 3 || "$1" != /* ]]; then
  usage
  exit 2
fi

readonly evidence_dir="$1"
readonly requested_node="${2:-}"
readonly requested_vmm="${3:-}"

if [[ -n "$requested_node" ]] && ! node_address "$requested_node" >/dev/null; then
  echo "unknown Kubernetes node: $requested_node" >&2
  exit 2
fi

if [[ -n "$requested_vmm" ]] && ! runtime_class_for_vmm "$requested_vmm" >/dev/null; then
  echo "unknown VMM: $requested_vmm" >&2
  exit 2
fi

for command in jq kubectl openssl rg talosctl; do
  if ! command -v "$command" >/dev/null; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

install -d "$evidence_dir"

kubectl --context "$KUBE_CONTEXT" get runtimeclass -o yaml >"$evidence_dir/runtimeclasses.yaml"
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get daemonset -o yaml \
  >"$evidence_dir/existing-daemonsets.yaml"

permanent_canary_daemonsets="$(
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get daemonsets -o name \
    | rg '/(microvm-agent|nanoagent)-(qemu|clh|fc|dragonball)$' \
    | sed "s#^#$NAMESPACE/#" || true
)"
if kubectl --context "$KUBE_CONTEXT" get namespace "$RETIRED_NAMESPACE" >/dev/null 2>&1; then
  kubectl --context "$KUBE_CONTEXT" -n "$RETIRED_NAMESPACE" get daemonset -o yaml \
    >"$evidence_dir/retired-daemonsets.yaml"
  retired_canary_daemonsets="$(
    kubectl --context "$KUBE_CONTEXT" -n "$RETIRED_NAMESPACE" get daemonsets -o name \
      | rg '/(microvm-agent|nanoagent)-(qemu|clh|fc|dragonball)$' \
      | sed "s#^#$RETIRED_NAMESPACE/#" || true
  )"
  permanent_canary_daemonsets="${permanent_canary_daemonsets}${permanent_canary_daemonsets:+$'\n'}${retired_canary_daemonsets}"
fi
if [[ -n "$permanent_canary_daemonsets" ]]; then
  echo 'permanent Kata canary DaemonSets remain in an active or retired namespace; finish pruning:' >&2
  echo "$permanent_canary_daemonsets" >&2
  exit 1
fi

declare -a nodes
if [[ -n "$requested_node" ]]; then
  nodes=("$requested_node")
else
  nodes=('talos-192-168-1-194' 'turin' 'talos-192-168-1-85')
fi

declare -a vmms
if [[ -n "$requested_vmm" ]]; then
  vmms=("$requested_vmm")
else
  vmms=('qemu' 'clh' 'fc' 'dragonball')
fi

run_id="$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"
readonly run_id
active_pod=''
active_secret=''

delete_active_resources() {
  if [[ -z "$active_pod" || -z "$active_secret" ]]; then
    return 0
  fi

  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete \
    "pod/$active_pod" "secret/$active_secret" --ignore-not-found --wait=true --timeout=2m
}

cleanup_active_resources() {
  delete_active_resources >/dev/null 2>&1 || true
}

trap cleanup_active_resources EXIT

for node in "${nodes[@]}"; do
  address="$(node_address "$node")"
  node_dir="$evidence_dir/$node"
  install -d "$node_dir"

  kubectl --context "$KUBE_CONTEXT" get node "$node" -o yaml >"$node_dir/node.yaml"
  architecture="$(
    kubectl --context "$KUBE_CONTEXT" get node "$node" \
      -o jsonpath='{.status.nodeInfo.architecture}'
  )"

  talosctl --nodes "$address" --endpoints "$address" get extensions -o yaml \
    >"$node_dir/extensions.yaml"
  rg -q 'kata-runtimes' "$node_dir/extensions.yaml"

  talosctl --nodes "$address" --endpoints "$address" service cri \
    >"$node_dir/cri-service.txt"
  rg -q 'Running|STATE[[:space:]]+Running|state:[[:space:]]+Running' "$node_dir/cri-service.txt"

  talosctl --nodes "$address" --endpoints "$address" read /etc/cri/conf.d/10-kata-runtimes.part \
    >"$node_dir/10-kata-runtimes.part"
  for runtime_class in kata-qemu kata-clh kata-fc kata-dragonball; do
    rg -Fq "containerd.runtimes.${runtime_class}]" "$node_dir/10-kata-runtimes.part"
  done

  for vmm in "${vmms[@]}"; do
    runtime_class="$(runtime_class_for_vmm "$vmm")"
    runtime_label="runtime.proompteng.ai/kata-${vmm}"
    pod="kata-proof-${vmm}-${run_id}"
    secret="${pod}-bootstrap"
    bootstrap_token="$(openssl rand -hex 32)"
    active_pod="$pod"
    active_secret="$secret"

    if ! kubectl --context "$KUBE_CONTEXT" get node "$node" -o json \
      | jq -e --arg label "$runtime_label" '.metadata.labels[$label] == "ready"' >/dev/null; then
      echo "$node is missing required label: $runtime_label=ready" >&2
      exit 1
    fi
    kubectl --context "$KUBE_CONTEXT" get runtimeclass "$runtime_class" -o yaml \
      >"$node_dir/$vmm-runtimeclass.yaml"

    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" create -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${secret}
  labels:
    app.kubernetes.io/name: nanoagent
    app.kubernetes.io/component: runtime-acceptance
    runtime.proompteng.ai/acceptance-run: ${run_id}
type: Opaque
stringData:
  token: ${bootstrap_token}
---
apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  labels:
    app.kubernetes.io/name: nanoagent
    app.kubernetes.io/component: runtime-acceptance
    app.kubernetes.io/part-of: kata
    runtime.proompteng.ai/acceptance-run: ${run_id}
    runtime.proompteng.ai/target-node: ${node}
    runtime.proompteng.ai/vmm: ${vmm}
spec:
  runtimeClassName: ${runtime_class}
  restartPolicy: Never
  activeDeadlineSeconds: 900
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 20
  nodeSelector:
    kubernetes.io/hostname: ${node}
    runtime.proompteng.ai/kata-${vmm}: ready
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
    - key: node.kubernetes.io/unschedulable
      operator: Exists
      effect: NoSchedule
  securityContext:
    fsGroup: 65532
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: nanoagent
      image: ${NANOAGENT_IMAGE}
      imagePullPolicy: Always
      env:
        - name: MICROVM_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.uid
        - name: MICROVM_BOOTSTRAP_TOKEN
          valueFrom:
            secretKeyRef:
              name: ${secret}
              key: token
      ports:
        - name: http
          containerPort: 8080
          protocol: TCP
      startupProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 2
        failureThreshold: 60
      readinessProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 5
        failureThreshold: 3
      livenessProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 10
        failureThreshold: 3
      resources:
        requests:
          cpu: 25m
          memory: 32Mi
        limits:
          cpu: 500m
          memory: 512Mi
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 65532
      volumeMounts:
        - name: workspace
          mountPath: /workspace
  volumes:
    - name: workspace
      emptyDir:
        sizeLimit: 256Mi
EOF

    if ! kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait \
      --for=condition=Ready "pod/$pod" --timeout=10m; then
      kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get pod "$pod" -o yaml \
        >"$node_dir/$vmm-pod-failure.yaml" || true
      kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" describe pod "$pod" \
        >"$node_dir/$vmm-pod-failure.describe.txt" || true
      kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" logs "$pod" \
        >"$node_dir/$vmm-nanoagent-failure.log" 2>&1 || true
      exit 1
    fi
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get pod "$pod" -o json \
      >"$node_dir/$vmm-pod.json"
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" describe pod "$pod" \
      >"$node_dir/$vmm-pod.describe.txt"
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" logs "$pod" \
      >"$node_dir/$vmm-nanoagent.log"
    # Expansions in this single-quoted script are intentionally evaluated by the guest shell.
    # shellcheck disable=SC2016
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec "$pod" -c nanoagent -- /bin/sh -ceu '
      test "$(id -u)" = 65532
      test -x /bin/sh
      test -x /usr/local/bin/nanoagent
      test -w /workspace
      tr "\000" " " </proc/1/cmdline | grep -Fq /usr/local/bin/nanoagent

      marker=/workspace/.nanoagent-shell-proof-$$
      trap '\''rm -f "$marker"'\'' EXIT
      printf nanoagent-shell-ok >"$marker"
      test "$(cat "$marker")" = nanoagent-shell-ok
      rm "$marker"
      test ! -e "$marker"
      trap - EXIT

      printf "uid=%s\n" "$(id -u)"
      printf "architecture=%s\n" "$(uname -m)"
      printf "kernel_release=%s\n" "$(uname -r)"
      printf "boot_id=%s\n" "$(cat /proc/sys/kernel/random/boot_id)"
      printf "workspace=writable\n"
      printf "pid1=nanoagent\n"
    ' >"$node_dir/$vmm-shell.txt"
    kubectl --context "$KUBE_CONTEXT" get --raw \
      "/api/v1/namespaces/${NAMESPACE}/pods/${pod}:8080/proxy/evidence" \
      >"$node_dir/$vmm-guest-evidence.json"
    talosctl --nodes "$address" --endpoints "$address" containers --kubernetes \
      >"$node_dir/$vmm-kubernetes-containers.txt"
    talosctl --nodes "$address" --endpoints "$address" processes \
      | rg '(^|[ /])(PID|containerd-shim-kata-v2|qemu-system-(x86_64|aarch64)|cloud-hypervisor|firecracker|virtiofsd)([ /]|$)' \
      >"$node_dir/$vmm-vmm-processes.txt"
    talosctl --nodes "$address" --endpoints "$address" logs cri --tail 4000 \
      >"$node_dir/$vmm-cri.log"

    jq -e --arg architecture "$architecture" '
      .state == "ready"
      and .architecture == $architecture
      and (.bootId | length > 0)
      and (.kernelRelease | length > 0)
      and (.bootstrapTokenSha256 | length == 64)
      and (.microvmId | length > 0)
    ' "$node_dir/$vmm-guest-evidence.json" >/dev/null
    jq -e --arg runtime_class "$runtime_class" '.spec.runtimeClassName == $runtime_class' \
      "$node_dir/$vmm-pod.json" >/dev/null
    rg -Fq "$NAMESPACE/$pod" "$node_dir/$vmm-kubernetes-containers.txt"
    rg -Fxq 'uid=65532' "$node_dir/$vmm-shell.txt"
    rg -Fxq 'workspace=writable' "$node_dir/$vmm-shell.txt"
    rg -Fxq 'pid1=nanoagent' "$node_dir/$vmm-shell.txt"
    rg -Fxq "kernel_release=$(jq -r '.kernelRelease' "$node_dir/$vmm-guest-evidence.json")" \
      "$node_dir/$vmm-shell.txt"
    rg -Fxq "boot_id=$(jq -r '.bootId' "$node_dir/$vmm-guest-evidence.json")" \
      "$node_dir/$vmm-shell.txt"

    case "$architecture" in
      amd64) rg -Fxq 'architecture=x86_64' "$node_dir/$vmm-shell.txt" ;;
      arm64) rg -Fxq 'architecture=aarch64' "$node_dir/$vmm-shell.txt" ;;
      *)
        echo "unsupported node architecture: $architecture" >&2
        exit 1
        ;;
    esac

    if rg -Fq "$bootstrap_token" "$node_dir/$vmm-nanoagent.log"; then
      echo "$node/$vmm nanoagent log exposed the bootstrap token" >&2
      exit 1
    fi

    case "$vmm" in
      qemu)
        rg -q 'qemu-system-(x86_64|aarch64)' "$node_dir/$vmm-vmm-processes.txt"
        ;;
      clh)
        rg -q 'cloud-hypervisor' "$node_dir/$vmm-vmm-processes.txt"
        ;;
      fc)
        rg -q '(^|[ /])firecracker([ /]|$)' "$node_dir/$vmm-vmm-processes.txt"
        ;;
      dragonball)
        # Dragonball is linked into runtime-rs and intentionally has no separate VMM process.
        rg -q 'containerd-shim-kata-v2' "$node_dir/$vmm-vmm-processes.txt"
        rg -Fq 'configuration-dragonball.toml' "$node_dir/10-kata-runtimes.part"
        ;;
    esac

    delete_active_resources >"$node_dir/$vmm-cleanup.txt"
    active_pod=''
    active_secret=''
  done
done

echo "all requested Kata runtime proofs passed; evidence: $evidence_dir"
