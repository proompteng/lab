# GlitchTip exception tracking

GlitchTip runs as a dedicated Argo CD application at
`https://glitchtip.ide-newton.ts.net` (Tailscale-only HTTPS ingress; no public ingress).
The official Helm chart is pinned to 9.0.1 and the app to 6.2.6.

- Persistent data: the chart-managed CloudNativePG `glitchtip-pg` cluster, on
  `rook-ceph-block`, two 20Gi PVCs. Do not prune the CNPG cluster during an
  application upgrade or application deletion.
- Application key: `Password/glitchtip-app-key` and
  `ExternalSecret/glitchtip-app-key`, using `CreatedOnce`. **Back up the resulting
  key before any secret deletion**: losing it invalidates signed tokens/sessions.
- Email: `ExternalSecret/glitchtip-brevo-email` reads the same 1Password
  `brevo/{username,password,from,to}` entries used by Mimir Alertmanager.
  `EMAIL_URL` uses SMTP STARTTLS on `smtp-relay.brevo.com:587` and URL-encodes
  credentials without putting them in Git or logs. Rotate credentials in the
  existing provider, not the application repository.
- Valkey is intentionally disabled. GlitchTip 6.2 uses its documented
  PostgreSQL fallback for async tasks and sessions. Reconsider only if volume
  warrants it. The existing Grafana LGTM stack remains authoritative for
  metrics, logs, and distributed traces.
- The upstream migration Job has Helm hook annotations replaced with an Argo CD
  sync hook; CNPG, secret material, migrations, web, and ingress run in order.
  The upstream chart **does not copy `extraEnvVars` to the migration Job**.
  Keep `migrationJob.extraEnvVars.VALKEY_URL` empty as well as the web value,
  or Django omits the `db` task-queue and `sessions` migration apps.

## Delivery and verification

1. Render with Helm 3: `kustomize build --enable-helm argocd/applications/glitchtip`.
2. Merge the PR, then allow the `platform` ApplicationSet to create the
   `glitchtip` application and namespace. Verify it follows the merged revision.
3. Check `kubectl -n glitchtip get cluster,pods,job,ingress,externalsecret`
   and that both ExternalSecrets report `Ready=True` (never print Secret data).
4. Confirm `glitchtip-migrate` succeeds and `glitchtip-web` has two healthy pods.
   Also run `python manage.py showmigrations db sessions` inside a web pod and
   verify **all** migrations are applied. A successful migration Job alone is
   insufficient: it can omit backend-specific migrations if its environment
   differs from the web pods. Test `/_health/` and the registration/login page.
5. Send a one-time SMTP test to the **existing** operations recipient using
   Django `send_mail`, then confirm provider delivery without printing emails
   or credentials. Rotate nothing and send to no new destination.
6. After an operator signs up inside Tailscale, create a GlitchTip project and
   configure its DSN in the applications that should report exceptions.

Upstream chart: <https://gitlab.com/glitchtip/glitchtip-helm-chart>.
Rollback: revert the chart/application revision and reconcile `glitchtip`;
**retain the CloudNativePG PVCs, database and stable Secret**.
