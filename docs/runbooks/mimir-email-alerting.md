# Mimir Email Alerting Runbook

## Overview

The observability stack uses Grafana Mimir Ruler for alert evaluation and Mimir Alertmanager for routing. Critical infrastructure alerts are routed to email through Resend SMTP.

GitOps source:

- `argocd/applications/observability/mimir-values.yaml`
- `argocd/applications/observability/graf-mimir-rules.yaml`
- `argocd/applications/observability/observability-alertmanager-email-externalsecret.yaml`
- `argocd/applications/observability/observability-mimir-rule-loader.yaml`

## Secret Contract

The Kubernetes Secret is `observability/observability-alertmanager-email`, created by External Secrets from `ClusterSecretStore/onepassword-infra`.
The same ExternalSecret renders `alertmanager_fallback_config.yaml`, which is mounted into Mimir Alertmanager at `/configs/alertmanager_fallback_config.yaml`.
Do not put `${...}` placeholders in `alertmanager.fallbackConfig`; Mimir expands environment variables in its main config, not in the mounted fallback Alertmanager config file.

Required 1Password fields in item `infra/resend`:

| 1Password field | Kubernetes key |
| --- | --- |
| `password` | `smtp-password` |
| `from` | `smtp-from` |
| `to` | `email-to` |

The Resend SMTP username is always `resend` and is set directly in Mimir Alertmanager config.

Do not commit SMTP credentials or recipient addresses.

## Routing Contract

Only alerts with both labels are emailed:

```yaml
severity: critical
notify: email
```

Warning alerts are evaluated and visible in Mimir/Grafana, but they do not send email by default.

## Rule Delivery

`graf-mimir-rules.yaml` is a ConfigMap source file. It is not mounted into the Mimir ruler pod. The `observability-mimir-rule-loader` Argo CD PostSync Job uploads each rule group to the Mimir Ruler API for tenant `anonymous`:

```text
POST /prometheus/config/v1/rules/lab
```

The loader also deletes stale groups from the `lab` namespace when it can read current rule state.

## Deployment

```bash
mise exec helm@3 -- kustomize build --enable-helm /Users/gregkonush/github.com/lab/argocd/applications/observability

argocd app sync observability
argocd app wait observability --health --sync --timeout 900
```

## Validation

Confirm the ExternalSecret and target Secret:

```bash
kubectl --context galactic-tailscale -n observability get externalsecret observability-alertmanager-email
kubectl --context galactic-tailscale -n observability get secret observability-alertmanager-email
```

Confirm the Secret-rendered Alertmanager fallback config contains the email receiver. Do not print the SMTP
password value in normal operations.

```bash
kubectl --context galactic-tailscale -n observability get secret \
  observability-alertmanager-email \
  -o go-template='{{ index .data "alertmanager_fallback_config.yaml" | base64decode }}' | \
  grep -E 'critical-email|smtp_smarthost|smtp_auth_username'
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

1. If `observability-alertmanager-email` is missing, verify the `observability` namespace has label `external-secrets.proompteng.ai/enabled: "true"` and the 1Password item fields exist.
2. If Alertmanager returns `406 Not initializing the Alertmanager`, check `observability-mimir-alertmanager-0` logs for fallback config parse errors. Mimir tenant configs reject `smtp_auth_password_file`; the password must be rendered into the Secret-backed config file as `smtp_auth_password`.
3. If rule upload fails, inspect the PostSync Job logs and verify the Mimir gateway service exists.
4. If alerts evaluate but email does not send, check `observability-mimir-alertmanager-0` logs for SMTP authentication or recipient errors.
5. If metrics are missing, verify workloads write to `observability-mimir-gateway`, not the retired `observability-mimir-nginx` service name.

## References

- [Grafana Mimir configuration parameters](https://grafana.com/docs/mimir/latest/configure/configuration-parameters/)
- [Grafana Mimir distributed Helm chart configuration](https://grafana.com/docs/helm-charts/mimir-distributed/latest/run-production-environment-with-helm/configuration-with-helm/)
- [Prometheus Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [External Secrets templating](https://external-secrets.io/latest/guides/templating/)
- [Resend SMTP integration](https://resend.com/docs/send-with-smtp)
