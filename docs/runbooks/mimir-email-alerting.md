# Mimir Email Alerting Runbook

## Overview

The observability stack uses Grafana Mimir Ruler for alert evaluation and Mimir Alertmanager for routing. Critical and warning alerts that opt into email are routed through Brevo SMTP.

GitOps source:

- `argocd/applications/observability/mimir-values.yaml`
- `argocd/applications/observability/graf-mimir-rules.yaml`
- `argocd/applications/observability/observability-alertmanager-email-externalsecret.yaml`
- `argocd/applications/observability/observability-mimir-rule-loader.yaml`

## Secret Contract

The Kubernetes Secret is `observability/observability-alertmanager-email-brevo`, created by
`ExternalSecret/observability-alertmanager-email` from `ClusterSecretStore/onepassword-infra`.
The same ExternalSecret renders `alertmanager_fallback_config.yaml`, which is mounted into Mimir Alertmanager at `/configs/alertmanager_fallback_config.yaml`.
Do not put `${...}` placeholders in `alertmanager.fallbackConfig`; Mimir expands environment variables in its main config, not in the mounted fallback Alertmanager config file.

Required 1Password fields in item `infra/brevo`:

| 1Password field | Kubernetes key  |
| --------------- | --------------- |
| `username`      | `smtp-username` |
| `password`      | `smtp-password` |
| `from`          | `smtp-from`     |
| `to`            | `email-to`      |

Use the SMTP login shown on Brevo's SMTP settings page for `username`.
Use a Brevo SMTP key for `password`, not an API key or account password.
The relay is `smtp-relay.brevo.com:587` with STARTTLS required.

Do not commit SMTP credentials or recipient addresses.

## Brevo Setup

1. Create a Brevo account and select the Free plan. Complete the required organization details and transactional-email activation.
2. Authenticate the existing sender domain in Brevo. Add the exact verification and DKIM records Brevo supplies to DNS.
   Preserve existing mail records and the domain's DMARC policy.
3. Add the existing alert sender in Brevo and confirm that it is verified.
4. Store the SMTP login and key in `infra/brevo`. Copy `from` and `to` from the existing alert configuration.
5. Test SMTP delivery before merging the provider change. Keep Resend active until the Brevo email arrives.
6. Sync the reviewed observability revision, verify the ExternalSecret is ready, and run the synthetic alert test below.

The Free plan allows 300 emails per day. Unused allowance does not roll over.
At the daily limit, Brevo queues up to 1,000 additional transactional emails; messages beyond that queue are not delivered.
Check Brevo's transactional logs when alerts are delayed or sending fails.

The `lab-alertmanager` SMTP key expires on October 11, 2027. Brevo also expires SMTP keys after
90 days without use. Record replacement keys' expiry in the 1Password item and test delivery regularly.
When rotating the key, wait for the target Secret to contain the new credential before rolling Alertmanager.

### Sending-domain DNS

These records authenticate `updates.proompteng.ai` for the current Brevo account in the Cloudflare
`proompteng.ai` zone. Use a 300-second TTL and DNS-only CNAMEs. The verification code is public DNS data;
if recreating the Brevo account, use the new code and DKIM targets supplied by that account.

| Type  | Name relative to `proompteng.ai` | Content                                       |
| ----- | -------------------------------- | --------------------------------------------- |
| TXT   | `updates`                        | `brevo-code:2efb1930274f21fc7ecdcc42d6ce1e8e` |
| CNAME | `brevo1._domainkey.updates`      | `b1.updates-proompteng-ai.dkim.brevo.com`     |
| CNAME | `brevo2._domainkey.updates`      | `b2.updates-proompteng-ai.dkim.brevo.com`     |
| TXT   | `_dmarc.updates`                 | `v=DMARC1; p=reject; adkim=s; aspf=s;`        |

The sending subdomain has its own strict DMARC policy. Keep existing Resend DKIM and `send.updates`
records while other users may still depend on them. Brevo authentication does not require replacing
MX records, delegating nameservers, enabling link tracking, or forwarding DMARC reports to Brevo.

## Routing Contract

Email requires `notify: email` and one of these severity labels:

| Severity | Repeat interval while firing |
| -------- | ---------------------------- |
| `critical` | One hour |
| `warning` | Four hours |

Both routes send resolved notifications through the existing `critical-email` receiver. Alerts without the email
opt-in remain visible in Mimir/Grafana without sending email.

Ceph opts `CephClusterHealthError`, `CephSlowOps`, and `CephOsdCommitLatencyCritical` into this route with
`notify: email`. The route repeats firing notifications every hour and sends a resolved notification.
Ceph health warnings, scrub debt, and warning-level latency alerts remain visible without sending email.

## Email links and alert UI

Mimir 3.2 removed the embedded Alertmanager web UI. Grafana provides the UI through the provisioned
`Mimir Alertmanager` data source, UID `mimir-alertmanager`, using the Mimir implementation and gateway root URL.
Grafana adds `/alertmanager` to API requests itself. Do not include that prefix in the data source URL.

The email's **View In Alertmanager** link still uses `https://mimir.ide-newton.ts.net/alertmanager/`.
The gateway redirects only `/alertmanager` and `/alertmanager/` to
`https://grafana.ide-newton.ts.net/alerting/groups?alertmanager=Mimir%20Alertmanager#`.
The empty fragment clears the old `#/alerts?receiver=...` fragment from email links. Grafana selects Mimir
Alertmanager and shows its current alert groups. Resolved alerts no longer appear in that active view.
Sign in to Grafana if prompted.

Keep `alertmanager.external_url` on the Mimir host and prefix. Mimir also uses it for API routing.
The exact UI redirects leave `/alertmanager/api/v2/*`, `/api/v1/alerts`, and the Ruler API on Mimir.
Email routing and SMTP credentials remain managed by External Secrets. Grafana does not forward its own
managed alerts to this data source.

Roll out the reviewed observability revision through Argo CD. Grafana must reload its provisioned data
sources before the redirect can select Mimir Alertmanager. Validate both slash variants, then follow the
link from an existing email and confirm the selected Alertmanager and current alert groups. Verify
`/alertmanager/api/v2/alerts` still returns JSON. To recover from a failed rollout, revert both Helm values
files together and sync that reviewed revision. Reverting restores the previous API configuration and
also restores the broken UI landing page.

## Rule Delivery

`graf-mimir-rules.yaml` is a ConfigMap source file. It is not mounted into the Mimir ruler pod. The `observability-mimir-rule-loader` Argo CD PostSync Job uploads each rule group to the Mimir Ruler API for tenant `anonymous`:

```text
POST /prometheus/config/v1/rules/lab
```

The loader also deletes stale groups from the `lab` namespace when it can read current rule state.

## Deployment

```bash
nix develop -c kustomize build --enable-helm argocd/applications/observability

argocd app sync observability
argocd app wait observability --health --sync --timeout 900
```

The Brevo migration changes the mounted Secret to `observability-alertmanager-email-brevo`.
This starts a new pod that cannot mount its fallback config until External Secrets creates the Brevo Secret;
the existing Resend Secret cannot satisfy the mount. Sync waves alone do not provide this guarantee because
an updated ExternalSecret can still report its previous `Ready=True` condition.

Mimir reads the fallback config at startup. For later changes to the same Secret, first sync the
ExternalSecret change and verify its rendered data. Then bump the pod's
`observability.proompteng.ai/alertmanager-fallback-config-revision` annotation in a separate reviewed change.
An annotation bump in the same sync as a Secret update can start Mimir with the previous configuration.

Warnings with `notify="email"` use the existing `critical-email` receiver with a four-hour repeat interval. This
includes the publisher deadline, Bayn input and execution warnings and Restate metadata lag. The receiver name does
not make a warning critical. Warnings without that opt-in remain quiet, and critical alerts still require it. Validate
both the Secret's route and the running tenant configuration after the revision bump; the rule's `notify` label alone
does not establish delivery.

## Validation

Confirm the ExternalSecret and target Secret:

```bash
kubectl --context galactic-tailscale -n observability get externalsecret observability-alertmanager-email
kubectl --context galactic-tailscale -n observability get secret observability-alertmanager-email-brevo
```

Confirm the Secret-rendered Alertmanager fallback config contains the email receiver. Keep the SMTP login,
password, sender, and recipient out of validation output.

```bash
kubectl --context galactic-tailscale -n observability get secret \
  observability-alertmanager-email-brevo \
  -o json | python3 -c '
import base64, json, sys
secret = json.load(sys.stdin)["data"]
config = base64.b64decode(secret["alertmanager_fallback_config.yaml"]).decode()
for key in ("smtp-username", "smtp-password", "smtp-from", "email-to"):
    assert base64.b64decode(secret[key]), f"Missing {key}"
assert "smtp_smarthost: smtp-relay.brevo.com:587" in config
assert "smtp_require_tls: true" in config
assert "smtp_auth_username:" in config and "smtp_auth_password:" in config
assert "critical-email" in config
print("Brevo SMTP, TLS, credentials, and email receiver verified")
'
```

Confirm rule groups were uploaded:

```bash
kubectl --context galactic-tailscale -n observability logs job/observability-mimir-rule-loader

kubectl --context galactic-tailscale -n observability exec deploy/observability-grafana -- \
  sh -lc 'wget --header="X-Scope-OrgID: anonymous" -qO- \
  "http://observability-mimir-gateway.observability.svc.cluster.local/prometheus/config/v1/rules/lab"'
```

## Synthetic Email Test

Send a temporary synthetic alert to Alertmanager. Keep it active for longer than the critical route `group_wait` before resolving it.

```bash
kubectl --context galactic-tailscale -n observability exec deploy/observability-grafana -- sh -lc '
cat >/tmp/test-alert.json <<JSON
[
  {
    "labels": {
      "alertname": "SyntheticEmailAlert",
      "severity": "critical",
      "notify": "email",
      "service": "observability",
      "team": "platform"
    },
    "annotations": {
      "summary": "Synthetic email alert test",
      "description": "Temporary alert to validate Mimir Alertmanager email routing."
    },
    "generatorURL": "https://mimir.ide-newton.ts.net"
  }
]
JSON
wget --header="Content-Type: application/json" \
  --post-file=/tmp/test-alert.json \
  -qO- \
  http://observability-mimir-gateway.observability.svc.cluster.local/alertmanager/api/v2/alerts
'
```

After delivery is confirmed, silence or let the synthetic alert resolve by not resending it.

## Troubleshooting

1. If `observability-alertmanager-email-brevo` is missing, inspect `ExternalSecret/observability-alertmanager-email`, verify the `observability` namespace has label `external-secrets.proompteng.ai/enabled: "true"`, and confirm the 1Password item fields exist.
2. If Alertmanager returns `406 Not initializing the Alertmanager`, check `observability-mimir-alertmanager-0` logs for fallback config parse errors. Mimir tenant configs reject `smtp_auth_password_file`; the password must be rendered into the Secret-backed config file as `smtp_auth_password`.
3. If rule upload fails, inspect the PostSync Job logs and verify the Mimir gateway service exists.
4. If alerts evaluate but email does not send, check `observability-mimir-alertmanager-0` logs for SMTP authentication or recipient errors.
5. If metrics are missing, verify workloads write to `observability-mimir-gateway`, not the retired `observability-mimir-nginx` service name.

## References

- [Mimir 3.2 Alertmanager UI removal](https://github.com/grafana/mimir/blob/mimir-3.2.1/CHANGELOG.md#320)
- [Grafana Alertmanager data source provisioning](https://grafana.com/docs/grafana/latest/datasources/alertmanager/#provision-the-data-source)
- [Grafana Mimir configuration parameters](https://grafana.com/docs/mimir/latest/configure/configuration-parameters/)
- [Grafana Mimir distributed Helm chart configuration](https://grafana.com/docs/helm-charts/mimir-distributed/latest/run-production-environment-with-helm/configuration-with-helm/)
- [Prometheus Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [External Secrets templating](https://external-secrets.io/latest/guides/templating/)
- [Brevo SMTP integration](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP)
- [Brevo Free plan limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)
