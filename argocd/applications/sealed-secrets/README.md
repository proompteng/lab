# Sealed Secrets

[docs](https://github.com/bitnami-labs/sealed-secrets?tab=readme-ov-file#usage)

### Managed via ArgoCD (GitOps)

- This app is managed from the folder `argocd/applications/sealed-secrets/` using a Kustomize overlay that renders the upstream Helm charts. Do not `kubectl apply` upstream manifests directly.
- Controller namespace: `sealed-secrets`.

Verify app health:

```bash
kubectl -n argocd get application sealed-secrets
kubectl -n sealed-secrets get deploy,pod
```

Private HTTPS host:

- `https://sealed-secrets.k8s.proompteng.ai`
- Backed by `argocd/applications/sealed-secrets/ingressroute-sealed-secrets-k8s-private.yaml`
- Requires the wildcard `k8s.proompteng.ai` TLS secret to be reflected into the `sealed-secrets` namespace and the NUC Pi-hole CNAME entry in `devices/nuc/pihole/pihole.toml`

### Install kubeseal CLI

```bash
brew install kubeseal
```

### Fetch public cert (for sealing)

```bash
kubeseal \
  --controller-name sealed-secrets \
  --controller-namespace sealed-secrets \
  --fetch-cert > pub.pem
```

### Backup and restore the controller key (no re-encryption needed)

Backing up the controller's private key lets you recreate the cluster without re‑sealing existing `SealedSecret` manifests.

Backup the active key (recommended to store with SOPS or a secure vault such as 1Password—save the full YAML so you can reapply it verbatim):

```bash
# Find the current key Secret name
kubectl -n sealed-secrets get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o name

# Export the full Secret as YAML (includes base64-encoded private key)
kubectl -n sealed-secrets get secret <SECRET_NAME> -o yaml > sealed-secrets-key.backup.yaml

# Optional: also export PEM files
kubectl -n sealed-secrets get secret <SECRET_NAME> -o jsonpath='{.data.tls\.crt}' | base64 -d > sealed-secrets.crt
kubectl -n sealed-secrets get secret <SECRET_NAME> -o jsonpath='{.data.tls\.key}' | base64 -d > sealed-secrets.key

# Store the YAML in 1Password (CLI v1 example).
# We keep a secure note titled "Sealed Secrets Controller Key" in the shared `infra` vault.
op item create \
  --category "Secure Note" \
  --title "Sealed Secrets Controller Key" \
  --vault "infra" \
  "notesPlain=$(<sealed-secrets-key.backup.yaml)"
```

Restore on a new/rebuilt cluster (apply the saved secret *before* the controller starts so existing SealedSecrets keep working):

```bash
# Ensure the controller is installed in the sealed-secrets namespace first

# If a new key was auto-generated, remove it so your backup becomes the active key
kubectl -n sealed-secrets delete secret -l sealedsecrets.bitnami.com/sealed-secrets-key --ignore-not-found=true

# Apply your backed-up Secret
# (download the YAML from 1Password or restore via CLI)
op item get "Sealed Secrets Controller Key" --vault "infra" --format json \
  | jq -r '.details.notesPlain' > sealed-secrets-key.backup.yaml

kubectl apply -f sealed-secrets-key.backup.yaml

# Restart the controller to pick up the restored key
kubectl -n sealed-secrets rollout restart deploy sealed-secrets
kubectl -n sealed-secrets rollout status deploy sealed-secrets --timeout=60s

# (Optional) Fetch the public cert and re-verify
kubeseal --controller-name sealed-secrets --controller-namespace sealed-secrets --fetch-cert > pub.pem
```

### Rotate the key after restoring (safe, without breaking existing secrets)

Goal: Keep the restored key available for decryption while creating a new active key for future sealing; re‑seal manifests at your pace, then drop the old key.

1) Make a backup copy of the restored (active) key Secret in the same namespace:

```bash
ACTIVE=$(kubectl -n sealed-secrets get secret -l sealedsecrets.bitnami.com/sealed-secrets-key=active -o jsonpath='{.items[0].metadata.name}')

# Duplicate the Secret with a new name and clean server-assigned fields
kubectl -n sealed-secrets get secret "$ACTIVE" -o yaml \
 | sed -e "s/name: ${ACTIVE}/name: sealed-secrets-key-backup/" \
       -e '/resourceVersion:/d' -e '/uid:/d' -e '/creationTimestamp:/d' \
 | kubectl apply -f -

# Mark the copy as a backup (not active)
kubectl -n sealed-secrets label secret sealed-secrets-key-backup \
  sealedsecrets.bitnami.com/sealed-secrets-key=backup --overwrite
```

2) Trigger creation of a new active key and restart the controller:

```bash
# Remove the current active key to force a new one to be generated
kubectl -n sealed-secrets delete secret "$ACTIVE"

# Restart controller and wait for readiness
kubectl -n sealed-secrets rollout restart deploy sealed-secrets
kubectl -n sealed-secrets rollout status deploy sealed-secrets --timeout=60s

# Verify you now have a new active key plus your backup
kubectl -n sealed-secrets get secret -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o custom-columns=NAME:.metadata.name,LABEL:.metadata.labels.sealedsecrets\.bitnami\.com/sealed-secrets-key,CREATED:.metadata.creationTimestamp
```

3) Fetch the new public cert and re‑seal your manifests:

```bash
kubeseal --controller-name sealed-secrets --controller-namespace sealed-secrets --fetch-cert > pub.pem
# Re-seal all SealedSecret manifests with the new pub.pem, then commit/apply
```

4) When all manifests have been re‑sealed and applied successfully, remove the backup key and restart once more:

```bash
kubectl -n sealed-secrets delete secret sealed-secrets-key-backup
kubectl -n sealed-secrets rollout restart deploy sealed-secrets
kubectl -n sealed-secrets rollout status deploy sealed-secrets --timeout=60s
```

### Encode / Decode helpers

```bash
echo -n 'bar' | base64             # encode
echo -n 'YmFy' | base64 --decode   # decode
```

Example `secret.yaml` (plain Secret to be sealed):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: foo
  namespace: foonamespace
type: Opaque
data:
  password: YmFy
```

Create a `SealedSecret` from the plain Secret:

```bash
kubeseal \
  --controller-name sealed-secrets \
  --controller-namespace sealed-secrets \
  -f secret.yaml -w sealed-foo.yaml
```

Apply the resulting `SealedSecret` to the cluster (or commit it under the appropriate app folder in `argocd/applications/*` and let ArgoCD sync).

### Key rotation (destructive)

Rotating the controller key invalidates existing `SealedSecret` objects. Re‑seal and redeploy them after rotation.

```bash
# Delete any existing keys in the sealed-secrets namespace
kubectl -n sealed-secrets delete secret -l sealedsecrets.bitnami.com/sealed-secrets-key --ignore-not-found=true

# Restart controller to generate a new keypair
kubectl -n sealed-secrets rollout restart deploy sealed-secrets
kubectl -n sealed-secrets rollout status deploy sealed-secrets --timeout=60s

# Fetch the new public cert
kubeseal --controller-name sealed-secrets --controller-namespace sealed-secrets --fetch-cert > pub.pem
```

### Manage exclusively via ArgoCD

This controller is installed and managed via the `argocd/applications/sealed-secrets` folder. Avoid applying upstream manifests directly.

### Create dockerconfig.json

Create `auth`:

```bash
echo -n 'user:password' | base64
```

Create `dockerconfig.json`:

```json
{ "auths": { "gitea.grisha.cloud": { "auth": "dXNlcjpwYXNzd29yZA==" } } }
```

Encode json with `base64`:

```bash
echo -n '{"auths":{"gitea.grisha.cloud":{"auth":"dXNlcjpwYXNzd29yZA=="}}}' | base64
```

Place output into secret yaml:

```yaml
apiVersion: v1
kind: Secret
type: kubernetes.io/dockerconfigjson
metadata:
  name: gitea-registry
  namespace: ecran
data:
  .dockerconfigjson: eyJhdXRocyI6eyJnaXRlYS5wcm9vbXB0ZW5nLmFpIjp7ImF1dGgiOiJkWE5sY2pwd1lYTnpkMjl5WkE9PSJ9fX0=
```

Finally create a sealed-secret from the plain text secret:

```bash
kubeseal \
  --controller-name sealed-secrets \
  --controller-namespace sealed-secrets \
  -f secret.yaml -w sealed-registry.yaml
```
