# Grafana dashboard GitOps workflow

This guide explains how we provision Grafana dashboards via ConfigMaps using the Helm chart sidecar, how to vet dashboard JSON before committing, and when to escalate to the Grafana Operator.

## Provisioning flow

1. Export the dashboard JSON from Grafana. Leave "Export for sharing externally" unchecked so the `uid` is preserved; provisioning uses the UID to update the existing dashboard instead of creating duplicates.
2. Save the JSON under `argocd/applications/observability/grafana-dashboards/` (one file per dashboard) and keep the JSON formatting intact.
3. Add annotations and labels via `kustomization.yaml`:
   - `metadata.labels.grafana_dashboard=true` so the sidecar picks up the ConfigMap.
   - `metadata.annotations.grafana_folder=<Folder>` to land the dashboard in the targeted Grafana folder.
4. Run `kustomize build argocd/applications/observability` to confirm the generated ConfigMaps render successfully.
5. Commit the change along with the `grafana-values.yaml` updates that enable the dashboard sidecar.
6. After Argo CD syncs, validate in staging with `kubectl -n observability get configmap -l grafana_dashboard=true` and confirm the dashboards load in Grafana.

### Sidecar expectations

- The Helm chart sidecar watches ConfigMaps with the configured label/value and mirrors their contents to `/var/lib/grafana/dashboards` inside the pod.
- `sidecar.dashboards.folderAnnotation` lets us map ConfigMaps to specific Grafana folders without shipping custom providers.
- Enabling `provider.foldersFromFilesStructure` supports mirroring nested folder names if we later split dashboards into subdirectories.

## Curating dashboards

- Prefer dashboards we author internally; when importing from community sources (for example, dotdc/grafana-dashboards-kubernetes), review every panel, align datasource UIDs with `prom`, `loki`, and `tempo`, and capture attribution in the README.
- Trim unused panels and variables before committing.
- Keep ConfigMaps under ~1 MiB. Split very large dashboards across multiple ConfigMaps or migrate them to the Grafana Operator.

## When to choose Grafana Operator CRDs

Use Grafana Operator custom resources instead of ConfigMaps when you need:

- Nested folder hierarchies or folder-level RBAC policies (`GrafanaFolder` CRs enforce ownership and permissions).
- Dashboards that exceed the ConfigMap size ceiling or ship as archives.
- Fine-grained reconciliation behaviour (for example, disabling ConfigMap caching).

The Operator can provision dashboards, datasources, and folders via `GrafanaDashboard`, `GrafanaDatasource`, and `GrafanaFolder` CRs. It requires managing the operator deployment alongside the Helm chart or replacing the chart entirely.

## Vetting checklist

- [ ] Dashboard JSON retains its `uid` and points to supported datasource UIDs.
- [ ] ConfigMap metadata includes `grafana_dashboard=true` and an appropriate `grafana_folder` annotation.
- [ ] `kustomize build argocd/applications/observability` succeeds without warnings.
- [ ] Dashboard JSON is <1 MiB; escalate to Grafana Operator if larger.
- [ ] README documents the source (internal vs. third-party) and review status.

## Operational tips

- Treat dashboards like code: request reviews, include screenshots for major visual changes, and track follow-up work in issues.
- Avoid editing provisioned dashboards directly in the UI. Grafana marks provisioned dashboards as read-only; UI edits will be lost on the next sync.
- If a ConfigMap change does not reflect promptly, confirm Argo CD synced, then check sidecar logs for parse errors.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Dashboard appears in "General" instead of the intended folder | Missing or misspelled `grafana_folder` annotation | Update the ConfigMap annotations and re-sync |
| Dashboard missing entirely | ConfigMap larger than 1 MiB or label mismatch | Split the dashboard or move to Grafana Operator; confirm `grafana_dashboard=true` |
| Datasource errors | UID mismatch between dashboard JSON and provisioned datasources | Update the dashboard JSON or datasource definitions to align on UIDs |
