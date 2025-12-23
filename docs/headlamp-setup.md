# Headlamp Setup (OIDC + RBAC)

This runbook covers Headlamp deployment, OIDC wiring with Keycloak, control-plane OIDC args, and RBAC.

## Deployment layout

- Argo CD app path: `argocd/applications/headlamp`
- Namespace: `headlamp`
- Helm release: `headlamp` (chart from https://kubernetes-sigs.github.io/headlamp)
- OIDC secret (SealedSecret): `argocd/applications/headlamp/headlamp-oidc-sealedsecret.yaml`
- RBAC manifest: `argocd/applications/headlamp/headlamp-oidc-rbac.yaml`

## Keycloak client (OIDC)

Create a confidential OpenID Connect client (e.g., `kubernetes`) and use it for both Headlamp and the kube-apiserver.

Capabilities:
- Client authentication: **On**
- Standard flow: **On**
- Direct access grants: Off
- Implicit flow: Off
- Service accounts roles: Off
- PKCE: None

Login settings:
- Root URL: `https://headlamp.ide-newton.ts.net`
- Home URL: `https://headlamp.ide-newton.ts.net`
- Valid redirect URIs: `https://headlamp.ide-newton.ts.net/oidc-callback`
- Web origins: `https://headlamp.ide-newton.ts.net`
- Valid post logout redirect URIs: `https://headlamp.ide-newton.ts.net`

OIDC values:
- Issuer: `https://auth.proompteng.ai/realms/master`
- Scopes: `openid profile email`

Optional (recommended) group mapper:
- Mapper type: **Group Membership**
- Token claim name: `groups`
- Add to ID token: On
- Add to access token: On

## Reseal Headlamp OIDC secret

Update `argocd/applications/headlamp/headlamp-oidc-sealedsecret.yaml` whenever the client ID/secret changes.

```bash
kubectl -n headlamp create secret generic headlamp-oidc \
  --from-literal=OIDC_CLIENT_ID=kubernetes \
  --from-literal=OIDC_CLIENT_SECRET='<client-secret>' \
  --from-literal=OIDC_ISSUER_URL='https://auth.proompteng.ai/realms/master' \
  --from-literal=OIDC_SCOPES='openid profile email' \
  --from-literal=OIDC_CALLBACK_URL='https://headlamp.ide-newton.ts.net/oidc-callback' \
  --dry-run=client -o yaml \
  | kubeseal --controller-name sealed-secrets \
  --controller-namespace sealed-secrets -o yaml \
  > argocd/applications/headlamp/headlamp-oidc-sealedsecret.yaml
```

Commit and sync the Headlamp Argo CD app.

## Apply OIDC to the control plane (k3s)

Headlamp tokens are validated by the kube-apiserver, so OIDC settings must be applied on all control-plane nodes.

Playbook:
- `ansible/playbooks/k3s-oidc.yml`
- Writes `/etc/rancher/k3s/config.yaml.d/oidc.yaml` and restarts k3s **serially**.
- Defaults to `remote_user: kalmyk`.

Run:

```bash
ANSIBLE_HOST_KEY_CHECKING=False \
  ansible-playbook -i ansible/inventory/hosts.ini \
  ansible/playbooks/k3s-oidc.yml \
  --ssh-extra-args='-o StrictHostKeyChecking=accept-new'
```

Optional overrides:

```bash
ansible-playbook -i ansible/inventory/hosts.ini ansible/playbooks/k3s-oidc.yml \
  --extra-vars 'k3s_oidc_client_id=kubernetes k3s_oidc_issuer_url=https://auth.proompteng.ai/realms/master'
```

If Keycloak uses a private CA, provide:

```
--extra-vars 'k3s_oidc_ca_file=/etc/ssl/certs/your-ca.pem'
```

## RBAC (GitOps)

Grant permissions using a ClusterRoleBinding in GitOps.

Default binding (user-based):
- `argocd/applications/headlamp/headlamp-oidc-rbac.yaml`
- Binds `User: oidc:gregkonush` to `cluster-admin`.

If you prefer group-based RBAC, change the subject to:

```yaml
subjects:
  - kind: Group
    name: oidc:<your-group>
```

Make sure the Keycloak groups mapper is configured so the `groups` claim is present.

## Troubleshooting

- **401 Unauthorized**: kube-apiserver OIDC config missing or mismatched (issuer/client-id/CA).
- **403 Forbidden**: RBAC missing. Add/update `headlamp-oidc-rbac.yaml` and sync Argo CD.
- **Old config in Headlamp**: sync the Argo CD app and restart the deployment:

```bash
argocd app sync headlamp
kubectl -n headlamp rollout restart deploy/headlamp
```
