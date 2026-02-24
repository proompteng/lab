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
  - For longer-lived Headlamp sessions, include `offline_access` and ensure it is assigned to the client (Default or Optional + requested).

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

## Session tuning (Keycloak)

Headlamp relies on refresh tokens to avoid frequent logouts. Set realm and client session values in Keycloak:

Balanced profile (recommended for Headlamp):

- Realm settings → Sessions
  - SSO Session Idle: 8 hours
  - SSO Session Max: 1 day
  - Client Session Idle: 8 hours
  - Client Session Max: 1 day
  - Offline Session Idle: 30 days
  - Client Offline Session Idle: 30 days
  - Offline Session Max Limited: Enabled
  - Offline Session Max: 30 days
  - Client Offline Session Max: 30 days

Also ensure the client has the `offline_access` scope assigned (Clients → <client> → Client scopes).
Log out/in to Headlamp after changes so it receives a new refresh token.

## Apply OIDC to the control plane (Talos)

Headlamp tokens are validated by the kube-apiserver, so OIDC settings must be applied on all control-plane nodes.

Talos patch files (cluster inventory: `devices/galactic/docs/tailscale.md`):

- `devices/ryzen/manifests/oidc-keycloak.patch.yaml`
- `devices/ampone/manifests/oidc-keycloak.patch.yaml`
- `devices/altra/manifests/oidc-keycloak.patch.yaml`

```bash
talosctl patch machineconfig -n 192.168.1.194 -e 192.168.1.194 \
  --patch @devices/ryzen/manifests/oidc-keycloak.patch.yaml \
  --mode=no-reboot

talosctl patch machineconfig -n 192.168.1.203 -e 192.168.1.203 \
  --patch @devices/ampone/manifests/oidc-keycloak.patch.yaml \
  --mode=no-reboot

talosctl patch machineconfig -n 192.168.1.85 -e 192.168.1.85 \
  --patch @devices/altra/manifests/oidc-keycloak.patch.yaml \
  --mode=no-reboot
```

Validate:

```bash
kubectl -n kube-system get pods -l component=kube-apiserver -o wide
```

If Keycloak uses a private CA, provide:

Talos: mount the CA bundle into kube-apiserver via `cluster.apiServer.extraVolumes`, then set `oidc-ca-file`
to that path in `cluster.apiServer.extraArgs`.

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
