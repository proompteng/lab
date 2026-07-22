#!/bin/sh
set -eu

umask 077

toolchain_bin=/opt/lab-toolchain/bin

check_tool_version() {
  tool_name=$1
  expected_version=$2
  shift 2
  actual_version=$("$@")
  if [ "$actual_version" != "$expected_version" ]; then
    printf '%s version mismatch: expected %s, got %s\n' "$tool_name" "$expected_version" "$actual_version" >&2
    exit 1
  fi
}

check_tool_version node v24.11.1 "$toolchain_bin/node" --version
check_tool_version bun 1.3.14 "$toolchain_bin/bun" --version
check_tool_version bunx 1.3.14 "$toolchain_bin/bunx" --version
check_tool_version go 'go version go1.25.5 linux/amd64' "$toolchain_bin/go" version
check_tool_version helm v3.19.1 "$toolchain_bin/helm" version --template '{{.Version}}'
check_tool_version jq jq-1.8.1 "$toolchain_bin/jq" --version
check_tool_version kustomize v5.8.0 "$toolchain_bin/kustomize" version
check_tool_version kubeconform v0.7.0 "$toolchain_bin/kubeconform" -v
shellcheck_version=$("$toolchain_bin/shellcheck" --version | sed -n 's/^version: //p')
check_tool_version shellcheck 0.11.0 printf '%s' "$shellcheck_version"
yq_version=$("$toolchain_bin/yq" --version | sed 's/^.* version //')
check_tool_version yq v4.49.2 printf '%s' "$yq_version"
unset shellcheck_version yq_version

mkdir -p \
  /opt/data/cron \
  /opt/data/home \
  /opt/data/logs \
  /opt/data/memories \
  /opt/data/pairing \
  /opt/data/platforms/pairing \
  /opt/data/plans \
  /opt/data/sessions \
  /opt/data/skills \
  /opt/data/workspace/tuslagch

install -m 0555 /opt/kubectl-image/bin/kubectl /opt/tools/kubectl
/opt/tools/kubectl version --client=true >/tmp/kubectl-version.log

kubeconfig_dir=${HOME}/.kube
kubeconfig_path=${kubeconfig_dir}/config
kubeconfig_tmp=${kubeconfig_path}.tmp.$$
: "${KUBERNETES_SERVICE_HOST:?Kubernetes service host is required}"
: "${KUBERNETES_SERVICE_PORT:?Kubernetes service port is required}"
install -d -m 0700 "$kubeconfig_dir"
cat >"$kubeconfig_tmp" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: in-cluster
    cluster:
      certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      server: https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}
contexts:
  - name: in-cluster
    context:
      cluster: in-cluster
      user: hermes
current-context: in-cluster
users:
  - name: hermes
    user:
      tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
EOF
chmod 0600 "$kubeconfig_tmp"
mv -- "$kubeconfig_tmp" "$kubeconfig_path"

/bin/sh /opt/bootstrap/bootstrap-lab-checkout.sh

seed_file() {
  source_path=$1
  destination_path=$2
  if [ ! -e "$destination_path" ]; then
    install -m 0600 "$source_path" "$destination_path"
  fi
}

seed_file /opt/bootstrap/USER.md /opt/data/memories/USER.md

/opt/hermes/.venv/bin/hermes config check >/tmp/hermes-config-check.log
/bin/sh /opt/bootstrap/bootstrap-github.sh
