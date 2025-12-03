# Grafana dashboards

This directory contains canonical exports of dashboards that are provisioned into Grafana via the Helm chart sidecar. Each file is exported JSON as downloaded from Grafana and should keep the `uid`, datasource references, and panel structure intact so provisioning updates the same dashboards instead of creating duplicates.

## Folder mapping

Dashboards are labeled with `grafana_dashboard=true` and annotated with `grafana_folder=Kubernetes`. The folder annotation aligns with the `sidecar.dashboards.folderAnnotation` value in `grafana-values.yaml`, so the sidecar writes the dashboards into `/var/lib/grafana/dashboards/Kubernetes` inside the pod. Adjust the annotation if a dashboard belongs in another folder or needs a nested path.

## Sourcing conventions

- Prefer exporting dashboards from an internal Grafana instance with datasources translated to stable UIDs.
- When adopting community dashboards (e.g., from dotdc/grafana-dashboards-kubernetes), review every panel, strip unused datasources, and ensure any licensing requirements are met.
- Keep each dashboard in its own file; large dashboards (>1 MiB) should graduate to Grafana Operator custom resources instead of ConfigMaps.
- Run `jq` or a Grafana dashboard linter locally if you need to normalize formatting before committing.

## Updating a dashboard

1. Export the dashboard JSON from Grafana, ensuring "Export for sharing externally" is **disabled** so the `uid` is preserved.
2. Drop the JSON into this directory, replacing the existing file if updating an existing dashboard.
3. Run `kustomize build argocd/applications/observability` locally to confirm the ConfigMap renders without exceeding size limits.
4. Commit the change with a Conventional Commit message that references the issue.
