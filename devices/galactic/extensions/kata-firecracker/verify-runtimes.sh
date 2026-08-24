#!/usr/bin/env bash

set -euo pipefail

readonly KUBE_CONTEXT='galactic-lan'
readonly NAMESPACE='microvm-system'

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

daemonset_for_vmm() {
  case "$1" in
    qemu) echo 'nanoagent-qemu' ;;
    clh) echo 'nanoagent-clh' ;;
    fc) echo 'nanoagent-fc' ;;
    dragonball) echo 'nanoagent-dragonball' ;;
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

if [[ -n "$requested_vmm" ]] && ! daemonset_for_vmm "$requested_vmm" >/dev/null; then
  echo "unknown VMM: $requested_vmm" >&2
  exit 2
fi

for command in jq kubectl rg talosctl; do
  if ! command -v "$command" >/dev/null; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

install -d "$evidence_dir"

kubectl --context "$KUBE_CONTEXT" get runtimeclass -o yaml >"$evidence_dir/runtimeclasses.yaml"
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get daemonset,pod -o wide \
  >"$evidence_dir/canaries.txt"

legacy_daemonsets="$(
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get daemonsets -o name \
    | rg '/microvm-agent-(qemu|clh|fc|dragonball)$' || true
)"
if [[ -n "$legacy_daemonsets" ]]; then
  echo 'legacy microvm-agent DaemonSets remain; sync kata-runtimes with pruning enabled:' >&2
  echo "$legacy_daemonsets" >&2
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

  talosctl --nodes "$address" --endpoints "$address" containers --kubernetes \
    >"$node_dir/kubernetes-containers.txt"
  talosctl --nodes "$address" --endpoints "$address" processes \
    | rg '(^|[ /])(PID|containerd-shim-kata-v2|qemu-system-(x86_64|aarch64)|cloud-hypervisor|firecracker|virtiofsd)([ /]|$)' \
    >"$node_dir/vmm-processes.txt"
  talosctl --nodes "$address" --endpoints "$address" logs cri --tail 4000 \
    >"$node_dir/cri.log"

  for vmm in "${vmms[@]}"; do
    runtime_class="$(runtime_class_for_vmm "$vmm")"
    daemonset="$(daemonset_for_vmm "$vmm")"
    pod="$(
      kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get pods \
        -l "app.kubernetes.io/name=nanoagent,runtime.proompteng.ai/vmm=${vmm}" \
        -o json \
        | jq -er --arg node "$node" '
            [.items[] | select(.spec.nodeName == $node) | .metadata.name]
            | if length == 1 then .[0] else error("expected exactly one canary pod on " + $node) end
          '
    )"

    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait \
      --for=condition=Ready "pod/$pod" --timeout=10m
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get daemonset "$daemonset" -o yaml \
      >"$node_dir/$vmm-daemonset.yaml"
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get pod "$pod" -o json \
      >"$node_dir/$vmm-pod.json"
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" logs "$pod" \
      >"$node_dir/$vmm-nanoagent.log"
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

      printf "uid=%s\n" "$(id -u)"
      printf "architecture=%s\n" "$(uname -m)"
      printf "kernel_release=%s\n" "$(uname -r)"
      printf "boot_id=%s\n" "$(cat /proc/sys/kernel/random/boot_id)"
      printf "workspace=writable\n"
      printf "pid1=nanoagent\n"
    ' >"$node_dir/$vmm-shell.txt"
    kubectl --context "$KUBE_CONTEXT" get runtimeclass "$runtime_class" -o yaml \
      >"$node_dir/$vmm-runtimeclass.yaml"
    kubectl --context "$KUBE_CONTEXT" get --raw \
      "/api/v1/namespaces/${NAMESPACE}/pods/${pod}:8080/proxy/evidence" \
      >"$node_dir/$vmm-guest-evidence.json"

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
    rg -Fq "$NAMESPACE/$pod" "$node_dir/kubernetes-containers.txt"
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

    if rg -Fq 'kata-canary-proof-v1' "$node_dir/$vmm-nanoagent.log"; then
      echo "$node/$vmm nanoagent log exposed the canary proof nonce" >&2
      exit 1
    fi

    case "$vmm" in
      qemu)
        rg -q 'qemu-system-(x86_64|aarch64)' "$node_dir/vmm-processes.txt"
        ;;
      clh)
        rg -q 'cloud-hypervisor' "$node_dir/vmm-processes.txt"
        ;;
      fc)
        rg -q '(^|[ /])firecracker([ /]|$)' "$node_dir/vmm-processes.txt"
        ;;
      dragonball)
        # Dragonball is linked into runtime-rs and intentionally has no separate VMM process.
        rg -q 'containerd-shim-kata-v2' "$node_dir/vmm-processes.txt"
        rg -Fq 'configuration-dragonball.toml' "$node_dir/10-kata-runtimes.part"
        ;;
    esac
  done
done

echo "all requested Kata runtime proofs passed; evidence: $evidence_dir"
