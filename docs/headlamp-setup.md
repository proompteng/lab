# Headlamp Setup (OIDC + RBAC)

This runbook covers Headlamp deployment, OIDC wiring with Keycloak, control-plane OIDC args, and RBAC.

## Deployment layout

- Argo CD app path: `argocd/applications/headlamp`
- Namespace: `headlamp`
- Helm release: `headlamp` (chart from https://kubernetes-sigs.github.io/headlamp)
- OIDC secret (SealedSecret): `argocd/applications/headlamp/headlamp-oidc-sealedsecret.yaml`
- RBAC manifest: `argocd/applications/headlamp/headlamp-oidc-rbac.yaml`
- OIDC auth bridge: `argocd/applications/headlamp/headlamp-auth-bridge-*.yaml`

## Operations model

- Headlamp application config is GitOps-managed from `argocd/applications/headlamp`.
- The `/auth` popup callback is fronted by a tiny auth bridge service so successful OIDC redirects can always hand control back to the main Headlamp window.
- Keycloak client bootstrap for Headlamp is GitOps-managed from `argocd/applications/keycloak/headlamp-client-bootstrap-job.yaml`.
- Kube-apiserver OIDC settings have an Ansible playbook only for `k3s` clusters: `ansible/playbooks/k3s-oidc.yml`.
- The current `galactic` cluster is Talos-based, so the control-plane OIDC path here is Talos machine config patches, not the `k3s` Ansible playbook.

Operationally:

1. Update or reseal the Headlamp OIDC secret in Git.
2. Update or reseal the Keycloak client bootstrap secret in Git.
3. Sync the `keycloak` and `headlamp` Argo CD apps.
4. If control-plane OIDC settings change, patch the Talos control-plane nodes listed below.

## Keycloak client (OIDC)

Create a confidential OpenID Connect client (e.g., `kubernetes`) and use it for both Headlamp and the kube-apiserver.
This repo now bootstraps that client from `argocd/applications/keycloak/headlamp-client-bootstrap-job.yaml`.

Capabilities:

- Client authentication: **On**
- Standard flow: **On**
- Direct access grants: Off
- Implicit flow: Off
- Service accounts roles: Off
- PKCE: None

Login settings:

- Valid redirect URIs:
  - `https://headlamp.ide-newton.ts.net/oidc-callback`
  - `https://headlamp.k8s.proompteng.ai/oidc-callback`
- Web origins:
  - `https://headlamp.ide-newton.ts.net`
  - `https://headlamp.k8s.proompteng.ai`

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

Update `argocd/applications/headlamp/headlamp-oidc-sealedsecret.yaml` and
`argocd/applications/keycloak/headlamp-client-sealedsecret.yaml` whenever the client ID/secret changes.

```bash
kubectl -n headlamp create secret generic headlamp-oidc \
  --from-literal=OIDC_CLIENT_ID=kubernetes \
  --from-literal=OIDC_CLIENT_SECRET='<client-secret>' \
  --from-literal=OIDC_ISSUER_URL='https://auth.proompteng.ai/realms/master' \
  --from-literal=OIDC_SCOPES='openid profile email' \
  --dry-run=client -o yaml \
  | kubeseal --controller-name sealed-secrets \
  --controller-namespace sealed-secrets -o yaml \
  > argocd/applications/headlamp/headlamp-oidc-sealedsecret.yaml
```

Headlamp now derives the callback URL dynamically from the request host when `config.oidc.callbackURL`
is omitted, so the same deployment can complete OIDC flows on both the Tailscale hostname and the private
`k8s.proompteng.ai` hostname.

Commit and sync the Keycloak and Headlamp Argo CD apps.

Recommended sync order:

1. Sync `keycloak` so the bootstrap job creates or updates the OIDC client.
2. Sync `headlamp` so the deployment consumes the matching client settings.
3. Restart `deploy/headlamp` only if the deployment does not roll automatically.

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
- **Redirect always goes to the Tailscale hostname**: the running Headlamp deployment still has a fixed `-oidc-callback-url`. Sync the updated Headlamp manifests so it can derive the callback from the request host.
- **Sign-in gets stuck on `/auth?cluster=...`**: sync the `headlamp-auth-bridge` resources and the patched Tailscale Ingress. The bridge page forces the popup flow to hand control back to the main Headlamp window even if Headlamp misses the original storage-event handoff.
- **Old config in Headlamp**: sync the Argo CD app and restart the deployment:

```bash
argocd app sync headlamp
kubectl -n headlamp rollout restart deploy/headlamp
```
