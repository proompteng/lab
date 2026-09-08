#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
safety_manifest="$repo_root/argocd/applications/kube-router/safety-policies.yaml"

desired_namespaces=$(
  {
    yq eval-all --no-doc --unwrapScalar 'select(.kind == "NetworkPolicy") | .metadata.namespace' "$safety_manifest"
    printf '%s\n' hermes
    if kubectl -n kube-system get namespace tengri >/dev/null 2>&1 &&
      kubectl -n tengri get networkpolicies.networking.k8s.io -o json |
        jq -e '.items | length > 0' >/dev/null; then
      printf '%s\n' tengri
    fi
  } | sort -u
)
actual_namespaces=$(
  kubectl get networkpolicies.networking.k8s.io --all-namespaces -o json |
    jq -r '.items[].metadata.namespace' |
    sort -u
)

if [[ "$actual_namespaces" != "$desired_namespaces" ]]; then
  echo 'NetworkPolicy namespace coverage changed; update and revalidate the kube-router safety policies.' >&2
  diff -u <(printf '%s\n' "$desired_namespaces") <(printf '%s\n' "$actual_namespaces") >&2 || true
  exit 1
fi

printf 'Safety coverage matches live NetworkPolicy namespaces:\n%s\n' "$desired_namespaces"
