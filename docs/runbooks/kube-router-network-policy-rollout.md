# kube-router NetworkPolicy production rollout

This runbook activates enforcement for `networking.k8s.io/v1` NetworkPolicies without replacing Flannel or kube-proxy.
The application is manual and must be rolled out only from merged `main`.

## Invariants

- Keep Flannel as the CNI and kube-proxy in nftables mode.
- Keep kube-router routing, service proxy, load-balancer allocation, CNI installation, and IPv6 disabled.
- Never activate the DaemonSet unless every namespace with an existing NetworkPolicy is approved by the safety verifier
  as either traffic-neutral, deliberately inert with no selected Pods, or enforcement-validated without an allow-all
  exception.
- Remove a temporary allow-all only in the reviewed change that records the namespace's validated graduated state in
  the safety verifier. Preserve all non-graduated safety policies during activation and rollback.
- Never delete the active DaemonSet without subsequently running the pinned cleanup DaemonSet on every node; kube-router
  rules persist after the controller exits.
- Stop immediately on node, workload, DNS, service routing, or policy-probe regression.

## 1. Release and cluster preflight

Run from the repository root and retain the non-secret output:

```bash
set -euo pipefail
git fetch --quiet origin main
main_revision=$(git rev-parse origin/main)
test "$(git rev-parse HEAD)" = "$main_revision"
test "$(crane digest docker.io/cloudnativelabs/kube-router:v2.11.1)" = \
  sha256:64da9a538d29e13780e256ce3897a52932a68657793bef009063bbeb2762146a
test "$(kubectl -n default get service kubernetes -o jsonpath='{.spec.clusterIP}')" = 10.96.0.1
kubectl -n kube-system get daemonset kube-proxy -o json |
  jq -e '.spec.template.spec.containers[0].command | any(. == "--proxy-mode=nftables")'
kubectl get nodes -o json |
  jq -e 'all(.items[]; any(.status.conditions[]; .type == "Ready" and .status == "True"))'
bash scripts/kube-router/verify-safety-coverage.sh
kustomize build argocd/applications/kube-router |
  kubeconform -strict -summary -ignore-missing-schemas
printf 'main=%s\n' "$main_revision"
```

Record a baseline before activation:

```bash
kubectl get nodes -o wide
kubectl get pods --all-namespaces -o json |
  jq -r '.items[] | select(any(.status.containerStatuses[]?; .ready != true)) | [.metadata.namespace,.metadata.name,.status.phase] | @tsv'
kubectl -n argocd get applications -o json |
  jq -r '.items[] | [.metadata.name,.status.sync.status,.status.health.status,.status.sync.revision] | @tsv' |
  sort
kubectl -n openclaw get virtualmachine,virtualmachineinstance,pvc -o wide
kubectl -n flamingo get deployment,pod,service -o wide
```

Expected image platform digests are
`sha256:05d1c7c903721ac202ce261fff33f61526e55188dc2135cdc39b4bcd173960a2` for amd64 and
`sha256:fec5ac13d36a812636d545263fda75e5b729ac9dac624f1f19f1170d3372324b` for arm64.

## 2. Manual activation

Refresh the manual application and require it to target the exact merged revision:

```bash
set -euo pipefail
argocd app get kube-router --refresh
test "$(kubectl -n argocd get application kube-router -o jsonpath='{.status.sync.revision}')" = "$main_revision"
argocd app sync kube-router --revision "$main_revision" --prune=false --timeout 600
kubectl -n kube-system rollout status daemonset/kube-router --timeout=10m
```

The sync hook must print `All existing NetworkPolicy namespaces have an approved rollout policy state.` It requires
traffic-neutral rollout policies in namespaces not yet graduated, Bayn's retained `Prune=false` object to use the inert
retired selector and match no Pods, and enforced Hermes and Tengri namespaces to match their exact reviewed
three-policy contracts. If the hook fails, the DaemonSet wave is not applied. Update the declared policy state through
Git and rerun CI; do not bypass the hook.

Verify every desired node has one ready controller, the pinned image index or its architecture-specific child manifest
is running, the process architecture matches the node, health is green, and policy metrics exist. Container runtimes
may report either the index digest or the selected child manifest as `imageID`, so the check deliberately accepts both
forms while still rejecting any unpinned digest:

```bash
set -euo pipefail
desired=$(kubectl -n kube-system get daemonset kube-router -o jsonpath='{.status.desiredNumberScheduled}')
ready=$(kubectl -n kube-system get daemonset kube-router -o jsonpath='{.status.numberReady}')
test "$desired" -gt 0
test "$ready" = "$desired"

kube_router_index_digest=sha256:64da9a538d29e13780e256ce3897a52932a68657793bef009063bbeb2762146a
pod_rows=$(
  kubectl -n kube-system get pods -l app.kubernetes.io/name=kube-router -o json |
    jq -er '
      .items as $pods
      | if ($pods | length) == 0 then error("no kube-router pods found") else $pods[] end
      | [.metadata.name,.spec.nodeName,.status.containerStatuses[0].ready,.status.containerStatuses[0].restartCount,.status.containerStatuses[0].imageID]
      | @tsv'
)
pod_count=$(awk 'NF { count += 1 } END { print count + 0 }' <<< "$pod_rows")
if [ "$pod_count" -ne "$desired" ]; then
  echo "expected $desired kube-router pods, found $pod_count" >&2
  exit 1
fi

controller_logs=
while IFS=$'\t' read -r pod node pod_ready restart_count image_id; do
  test "$pod_ready" = true
  test "$restart_count" = 0
  node_arch=$(kubectl get node "$node" -o jsonpath='{.status.nodeInfo.architecture}')
  case "$node_arch" in
    amd64)
      platform_digest=sha256:05d1c7c903721ac202ce261fff33f61526e55188dc2135cdc39b4bcd173960a2
      expected_runtime_arch=x86_64
      ;;
    arm64)
      platform_digest=sha256:fec5ac13d36a812636d545263fda75e5b729ac9dac624f1f19f1170d3372324b
      expected_runtime_arch=aarch64
      ;;
    *)
      echo "unsupported node architecture: $node_arch" >&2
      exit 1
      ;;
  esac
  case "$image_id" in
    *"@$kube_router_index_digest"|*"@$platform_digest") ;;
    *)
      echo "unexpected kube-router imageID on $pod: $image_id" >&2
      exit 1
      ;;
  esac
  test "$(kubectl -n kube-system exec "$pod" -c kube-router -- uname -m)" = "$expected_runtime_arch"
  kubectl -n kube-system exec "$pod" -c kube-router -- wget -qO- http://127.0.0.1:20244/healthz
  metrics=$(kubectl -n kube-system exec "$pod" -c kube-router -- wget -qO- http://127.0.0.1:20241/metrics)
  grep -Eq '^kube_router_controller_policy_(chains|ipsets) ' <<< "$metrics"
  pod_logs=$(kubectl -n kube-system logs "$pod" -c kube-router --prefix --tail=500)
  controller_logs+=$'\n'"$pod_logs"
done <<< "$pod_rows"
! grep -Eiq 'panic|fatal|permission denied|operation not permitted|failed to (sync|restore|create)' \
  <<< "$controller_logs"
unset controller_logs expected_runtime_arch image_id kube_router_index_digest metrics node node_arch platform_digest pod pod_count pod_logs pod_ready pod_rows restart_count
```

## 3. Enforcement and regression proof

The first disposable probe schedules a client and server on every Linux node, checks each client against a server on a
different node, proves an egress-deny policy blocks every one of those flows, and proves removal restores them. The
second probe repeats the contract using the exact amd64 Hermes runtime image. Both delete their namespace on exit:

```bash
set -euo pipefail
bash scripts/kube-router/verify-all-node-enforcement.sh
bash scripts/hermes/verify-network-policy-enforcement.sh
probe_namespaces=$(kubectl get namespaces -o name)
test -z "$(grep -E '(kube-router|hermes)-network-policy-probe' <<< "$probe_namespaces" || true)"
unset probe_namespaces
```

Compare the post-activation state with the baseline and prove OpenClaw and Flamingo remain healthy:

```bash
kubectl get nodes -o wide
kubectl get pods --all-namespaces -o json |
  jq -r '.items[] | select(any(.status.containerStatuses[]?; .ready != true)) | [.metadata.namespace,.metadata.name,.status.phase] | @tsv'
kubectl -n argocd get applications -o json |
  jq -r '.items[] | [.metadata.name,.status.sync.status,.status.health.status,.status.sync.revision] | @tsv' |
  sort
kubectl -n openclaw get virtualmachine,virtualmachineinstance,pvc -o wide
kubectl -n flamingo rollout status deployment/flamingo --timeout=10m
```

Do not sync Hermes unless the policy probe passes and there is no new workload regression.

## Emergency rollback and cleanup

This is the documented emergency exception to GitOps. Keep every safety policy in place. First stop reconciliation and
the active controller, then run the pinned targeted cleanup init container once on every Linux node. The cleanup removes
only `KUBE-ROUTER-*`, `KUBE-NWPLCY-*`, and `KUBE-POD-FW-*` filter chains plus their NetworkPolicy ipsets. It deliberately
does not use kube-router's generic cleanup mode, which can flush unrelated IPVS state:

```bash
set -euo pipefail
argocd app terminate-op kube-router || true
kubectl -n kube-system delete daemonset kube-router --wait=true
kustomize build argocd/applications/kube-router/operations/cleanup |
  kubectl -n kube-system apply -f -
kubectl -n kube-system rollout status daemonset/kube-router-cleanup --timeout=5m

kubectl -n kube-system get pods -l app.kubernetes.io/name=kube-router-cleanup -o json |
  jq -e 'all(.items[]; .status.initContainerStatuses[0].state.terminated.exitCode == 0)'
while IFS= read -r pod; do
  iptables_state=$(kubectl -n kube-system exec "$pod" -c verifier -- iptables-save)
  ipset_state=$(kubectl -n kube-system exec "$pod" -c verifier -- ipset list -name)
  if grep -Eq 'KUBE-(ROUTER|NWPLCY|POD-FW)-' <<< "$iptables_state"; then
    echo "targeted kube-router chains remain on $pod" >&2
    exit 1
  fi
  if grep -Eq '^(inet6:)?KUBE-(SRC|DST)-|^(inet6:)?kube-router-local-pods$' <<< "$ipset_state"; then
    echo "targeted kube-router ipsets remain on $pod" >&2
    exit 1
  fi
done < <(kubectl -n kube-system get pods -l app.kubernetes.io/name=kube-router-cleanup -o name)
unset iptables_state ipset_state

kubectl -n kube-system delete daemonset kube-router-cleanup --wait=true
set +e
rollback_probe_output=$(bash scripts/hermes/verify-network-policy-enforcement.sh 2>&1)
rollback_probe_status=$?
set -e
test "$rollback_probe_status" -ne 0
grep -q 'NetworkPolicy is not enforced' <<< "$rollback_probe_output"
unset rollback_probe_output rollback_probe_status
```

The final probe is expected to fail with `NetworkPolicy is not enforced`; it must still clean its disposable namespace.
Recheck node, DNS, service routing, OpenClaw, and Flamingo health. Revert the Git commit through the normal PR path so
Argo no longer desires the controller. Do not remove the safety policies until a separate policy rollout proves each
namespace's required traffic.


After retirement of the PostgreSQL and ClickHouse upgrade test namespaces,
the controller coverage gate recognizes the six additional namespaces below.
Their live policy names and complete specs match committed source at `5a8a64b4101cd379c9dc55c89f04bde947d4d56d`,
after Kubernetes omits empty ingress/egress arrays. The hook compares each exact
policy-set hash; no new rollout allow-all rules are installed. Keep the original
Hermes/Tengri contracts, Bayn inert selector check and traffic-neutral policies.

| Namespace | Policies | Source files |
| --- | --- | --- |
| buzz | 6 | `argocd/applications/buzz/networkpolicy.yaml` |
| observability | 2 | `argocd/applications/observability/grafana-upgrade-backup.yaml`, `argocd/applications/observability/mimir-kafka-upgrade-backup.yaml` |
| proompteng | 2 | `argocd/applications/proompteng/network-policy.yaml` |
| restate | 1 | `argocd/applications/restate/networkpolicy.yaml` |
| restate-example | 1 | `argocd/applications/restate-example/networkpolicy.yaml` |
| temporal | 6 | `argocd/applications/temporal/upgrade/cassandra-31119-backup.yaml`, `argocd/applications/temporal/upgrade/cassandra-4112-backup.yaml`, `argocd/applications/temporal/upgrade/cassandra-4112-v2-backup.yaml`, `argocd/applications/temporal/upgrade/cassandra-4112-v3-backup.yaml`, `argocd/applications/temporal/upgrade/cassandra-509-backup.yaml`, `argocd/applications/temporal/upgrade/elasticsearch-preparation.yaml` |

Before/after acceptance must preserve these policy specs and verify all-node
enforcement, DNS, service routing and native database isolation. The current
controller is already enforcing policy; this is a version upgrade.
