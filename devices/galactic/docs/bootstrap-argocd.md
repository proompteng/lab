# Bootstrap Argo CD (galactic)

This runbook documents how to bring up Argo CD on the `galactic` cluster in a way that is repeatable and avoids common bootstrap pitfalls.

## Prereqs

1. `kubectl` can reach the cluster through context `galactic-lan` or `galactic-tailscale`; see
   `docs/runbooks/galactic-kubernetes-access.md`. Select the reachable context once for the commands below:

   ```bash
   GALACTIC_CONTEXT=galactic-lan # or galactic-tailscale
   kubectl --context "$GALACTIC_CONTEXT" get nodes
   ```

1. Core components are healthy:
   - `kubectl --context "$GALACTIC_CONTEXT" get nodes`
   - `kubectl --context "$GALACTIC_CONTEXT" -n kube-system get pods | rg -n 'coredns|kube-flannel|kube-proxy'`

If Argo CD pods are failing with Redis timeouts or probe failures, fix networking first:

- `devices/galactic/docs/troubleshooting-networking.md`

## Install the ApplicationSet CRD first

Symptoms when missing:

- `argocd-applicationset-controller` CrashLoopBackOff.
- Logs contain: `no matches for kind "ApplicationSet" in version "argoproj.io/v1alpha1"`.

The upstream `applicationsets.argoproj.io` CRD can be large enough that `kubectl apply` fails with:

`CustomResourceDefinition.apiextensions.k8s.io "applicationsets.argoproj.io" is invalid: metadata.annotations: Too long: may not be more than 262144 bytes`

This is typically caused by `kubectl apply` trying to store the full object in the `kubectl.kubernetes.io/last-applied-configuration` annotation.

Recommended (server-side apply, avoids last-applied annotation):

```bash
kubectl --context "$GALACTIC_CONTEXT" apply --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.2/manifests/crds/applicationset-crd.yaml
```

Fallback (create-only, avoids last-applied annotation):

```bash
curl -fsSL https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.2/manifests/crds/applicationset-crd.yaml \
  | kubectl --context "$GALACTIC_CONTEXT" create -f -
```

Verify:

```bash
kubectl --context "$GALACTIC_CONTEXT" get crd applicationsets.argoproj.io
```

## Install Traefik CRDs (required by this repo's Argo CD manifests)

This repo's Argo CD install includes `IngressRoute` resources (Traefik CRDs):

- `argocd/applications/argocd/base/ingressroute.yaml`

On a fresh cluster, applying `argocd/applications/argocd` will fail until the Traefik CRDs exist.

Install the CRDs (pinned to the chart version we deploy):

```bash
kubectl --context "$GALACTIC_CONTEXT" apply --server-side --force-conflicts \
  -k https://github.com/traefik/traefik-helm-chart/traefik/crds/?ref=v39.0.9
```

Verify:

```bash
kubectl --context "$GALACTIC_CONTEXT" get crd ingressroutes.traefik.io
```

## Install Sealed Secrets and restore its controller key

The root Application creates the `bootstrap` ApplicationSet, whose `sealed-secrets` entry is automatic. On a fresh
or rebuilt cluster, finish this gate before applying `argocd/root.yaml`: the repository already contains
`SealedSecret` manifests encrypted with the retained controller key, and a newly generated key cannot decrypt them.

This is a one-time bootstrap exception. It applies the same repository-owned Sealed Secrets overlay directly so the
controller can start with the retained key before Argo CD begins automatic child synchronization. After the root
Application is healthy, stop applying this overlay directly and use the normal GitOps path. If the backup cannot be
retrieved or verified, stop here; do not apply the root Application.

Retrieve the complete controller-key Secret YAML from the approved secret store described in
`argocd/applications/sealed-secrets/README.md`. Keep that file outside the checkout with mode `0600`; never print,
commit, or paste its contents. Set `SEALED_SECRETS_KEY_BACKUP_PATH` in the shell before running this block:

```bash
set -euo pipefail
umask 077
: "${GALACTIC_CONTEXT:?Set GALACTIC_CONTEXT to galactic-lan or galactic-tailscale first}"
: "${SEALED_SECRETS_KEY_BACKUP_PATH:?Set this to the local 0600 controller-key YAML from approved secret storage}"
test -s "$SEALED_SECRETS_KEY_BACKUP_PATH"

# ApplicationSet will own this namespace after the root handoff; create it only for this preflight.
kubectl --context "$GALACTIC_CONTEXT" create namespace sealed-secrets --dry-run=client -o yaml \
  | kubectl --context "$GALACTIC_CONTEXT" apply --server-side --field-manager=galactic-bootstrap -f - >/dev/null

# Normalize the full kubectl YAML backup before applying it. Keep only the fields
# required to restore this key; never apply server-owned metadata from the old cluster.
SEALED_SECRETS_BOOTSTRAP_DIR="$(mktemp -d)"
trap 'rm -rf "$SEALED_SECRETS_BOOTSTRAP_DIR"' EXIT
SEALED_SECRETS_KEY_MANIFEST="$SEALED_SECRETS_BOOTSTRAP_DIR/controller-key.json"
kubectl --context "$GALACTIC_CONTEXT" -n sealed-secrets apply --dry-run=client \
  -f "$SEALED_SECRETS_KEY_BACKUP_PATH" -o json \
  | jq -e '
      if .kind == "Secret" and
         (.metadata.name | type == "string" and length > 0) and
         (.metadata.namespace == "sealed-secrets" or .metadata.namespace == null) and
         (.metadata.labels["sealedsecrets.bitnami.com/sealed-secrets-key"] != null) and
         .type == "kubernetes.io/tls" and
         (.data | has("tls.crt") and has("tls.key"))
      then {
        apiVersion: .apiVersion,
        kind: .kind,
        metadata: {
          name: .metadata.name,
          namespace: (.metadata.namespace // "sealed-secrets"),
          labels: .metadata.labels
        },
        type: .type,
        data: .data
      }
      else error("controller-key backup is not a valid Sealed Secrets TLS Secret")
      end
    ' > "$SEALED_SECRETS_KEY_MANIFEST"
chmod 600 "$SEALED_SECRETS_KEY_MANIFEST"

SEALED_SECRETS_KEY_NAME="$(kubectl --context "$GALACTIC_CONTEXT" -n sealed-secrets apply \
  --server-side --force-conflicts -f "$SEALED_SECRETS_KEY_MANIFEST" -o name)"
test -n "$SEALED_SECRETS_KEY_NAME"

# Install exactly the overlay Argo CD will later adopt. Run this from the repository root inside `nix develop`.
kustomize build --enable-helm argocd/applications/sealed-secrets \
  | kubectl --context "$GALACTIC_CONTEXT" -n sealed-secrets apply \
      --server-side --force-conflicts -f - >/dev/null

kubectl --context "$GALACTIC_CONTEXT" -n sealed-secrets rollout status \
  deployment/sealed-secrets --timeout=300s

# Confirm the restored Secret is still present and has key material, without exposing its values.
kubectl --context "$GALACTIC_CONTEXT" -n sealed-secrets get "$SEALED_SECRETS_KEY_NAME" -o json \
  | jq -e '
      .metadata.namespace == "sealed-secrets" and
      (.metadata.labels["sealedsecrets.bitnami.com/sealed-secrets-key"] != null) and
      .type == "kubernetes.io/tls" and
      (.data | has("tls.crt") and has("tls.key"))
    ' >/dev/null

# Verify that the controller serves the restored certificate; no private key or Secret data is printed.
kubectl --context "$GALACTIC_CONTEXT" -n sealed-secrets get "$SEALED_SECRETS_KEY_NAME" \
  -o jsonpath='{.data.tls\.crt}' | base64 --decode > "$SEALED_SECRETS_BOOTSTRAP_DIR/backup.crt"
kubeseal --context "$GALACTIC_CONTEXT" --controller-name sealed-secrets \
  --controller-namespace sealed-secrets --fetch-cert > "$SEALED_SECRETS_BOOTSTRAP_DIR/controller.crt"
cmp -s "$SEALED_SECRETS_BOOTSTRAP_DIR/backup.crt" "$SEALED_SECRETS_BOOTSTRAP_DIR/controller.crt"
```

The final `cmp` is the key gate: it proves the running controller is serving the restored certificate. Do not proceed
if it fails.

## Deploy Argo CD

Apply the repo-managed Argo CD manifests:

```bash
kubectl --context "$GALACTIC_CONTEXT" -n argocd apply --server-side --force-conflicts \
  -k argocd/applications/argocd
```

Wait for Argo CD control plane to be up:

```bash
kubectl --context "$GALACTIC_CONTEXT" -n argocd get pods
kubectl --context "$GALACTIC_CONTEXT" -n argocd rollout status deploy/argocd-server --timeout=180s
kubectl --context "$GALACTIC_CONTEXT" -n argocd rollout status deploy/argocd-repo-server --timeout=300s
```

## Access the UI (no ingress)

Port-forward:

```bash
kubectl --context "$GALACTIC_CONTEXT" -n argocd port-forward svc/argocd-server 8080:80
```

Then open `http://127.0.0.1:8080`.

## Credentials

Get the initial admin password:

```bash
argocd admin initial-password --kube-context "$GALACTIC_CONTEXT" -n argocd
```

## Next steps

1. Create and verify the one-time root Application handoff:
   - `argocd/applicationsets/README.md`
1. Let the root Application create the staged ApplicationSets; do not apply `bootstrap.yaml`, `platform.yaml`, or
   `product.yaml` directly.
1. If you reference Tailscale-only hostnames (for example `registry.ide-newton.ts.net`) in Kubernetes image references,
   verify the Omni-owned node-level Tailscale configuration first: `devices/galactic/docs/tailscale.md`.
