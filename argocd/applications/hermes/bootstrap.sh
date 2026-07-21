#!/bin/sh
set -eu

umask 077

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
