# dernier service

The `dernier` API is a production Rails 8.0.x deployment (currently 8.0.3, released September 22, 2025) running on Knative Serving with Argo CD managing desired state.citeturn5search1 CloudNativePG 1.27 provides the PostgreSQL control plane, while the OT-Container-Kit Redis Operator (v0.21.x+) furnishes Redis Sentinel/cluster capabilities for caching, session storage, and Solid Queue workers.citeturn0search0turn0search2turn1search3 Autoscaling is handled by Knative’s Kubernetes-backed HPA integration; manifests capture the default probe thresholds that Knative otherwise injects (failure threshold 3, timeout 1 second) to keep Argo CD in sync with live revisions.citeturn2search3turn2search8

## Architecture

- **Image:** `registry.ide-newton.ts.net/lab/dernier`
- **Namespace:** `dernier`
- **Database:** CloudNativePG 1.27 cluster `dernier-db` (primary service `dernier-db-rw`). The release supports PostgreSQL 17 by default and remains in active maintenance until ~February 2026.citeturn0search0turn0search2
- **Redis:** Redis Operator-managed instance `dernier-redis` (leader service `dernier-redis-leader`), compatible with Redis 7.0.12+.citeturn1search3
- **Ingress:** Knative Serving (Istio ingress gateway) exposes the route `https://dernier.proompteng.ai`.

## System Diagram

```mermaid
graph TD
  User((User / Client))
  KnativeIngress[Knative Ingress Gateway]
  DernierSvc[Knative Service<br/>dernier]
  Postgres[(CloudNativePG<br/>dernier-db)]
  Redis[(Redis Operator<br/>dernier-redis)]
  Secrets{{SealedSecret<br/>dernier-secrets}}
  CA[(Secret<br/>dernier-db-ca)]
  ArgoCD[Argo CD Application]

  User --> KnativeIngress
  KnativeIngress --> DernierSvc
  DernierSvc --> Postgres
  DernierSvc --> Redis
  Secrets --> DernierSvc
  CA --> DernierSvc
  ArgoCD --> DernierSvc
```

## Configuration

Environment variables arrive via the SealedSecret `dernier-secrets`:

- `RAILS_MASTER_KEY`
- `SECRET_KEY_BASE`

Additional runtime configuration:

- `DATABASE_URL` sourced from the CloudNativePG secret `dernier-db-app` (`key: uri`).
- `REDIS_URL` resolves to `redis://dernier-redis-leader:6379/1`.
- `PGSSLROOTCERT` mounts `/etc/postgres-ca/ca.crt` from `dernier-db-ca`.

### Frontend Tooling

- Tailwind CSS (currently 3.4, upgrade to v4 alpha after GA) powers the UI layer. Source tokens live in `app/assets/tailwind/application.css` and compile to `app/assets/builds/tailwind.css`.citehttps://tailwindcss.com/blog/tailwindcss-v3-4
- Run `bin/dev` (Procfile-backed) to boot Rails alongside the Tailwind watcher. Production builds run `rails tailwindcss:build`.
- Propshaft ships by default in Rails 8 and remains the asset pipeline of record even though controllers are API-first.citeturn5search4

### Local development

```bash
cd services/dernier
bundle install
bin/dev
```

`bin/dev` starts `rails server` (`http://localhost:3000`) plus the Tailwind watcher. Use local PostgreSQL/Redis or fall back to Docker:

```bash
docker compose up postgres redis

DATABASE_URL=postgres://postgres:postgres@localhost:5432/dernier_development \
REDIS_URL=redis://localhost:6379/1 \
bin/dev
```

The entrypoint prepares the database and exposes `/health` for readiness checks.

### Scaling & Availability

- HPA scales between 2–5 replicas (see `argocd/applications/dernier/overlays/cluster/hpa.yaml`).
- CloudNativePG provides HA failover once replicas join the cluster and enforces liveness-restart semantics introduced in 1.27.citeturn0search0
- Redis Operator bundles a redis-exporter sidecar listening on `:9121` for Prometheus scraping.citeturn1search0

### Secret Management

Rotate app secrets with `scripts/seal-generic-secret.sh`:

```bash
scripts/seal-generic-secret.sh \
  dernier dernier-secrets \
  argocd/applications/dernier/overlays/cluster/sealed-secret.yaml \
  RAILS_MASTER_KEY=<value> \
  SECRET_KEY_BASE=<value>
```

Commit the updated manifest and trigger an Argo CD sync.

## Deployment

```bash
# render manifests
kubectl kustomize argocd/applications/dernier/overlays/cluster

# sync via Argo CD CLI
argocd app sync dernier
```

## Health Checks

- HTTP: `GET https://dernier.proompteng.ai/health` returns `{ "status": "ok" }`
- Kubernetes: Deployment probes mirror the `/health` endpoint (readiness + liveness)

## Runbooks

- **Rollout:** Bump the image tag via CI (Skaffold profiles `dernier` / `dernier-remote`) or Argo CD Image Updater. Confirm HPA status with `kubectl get hpa -n dernier`.
- **Database Maintenance:** Use `kubectl cnpg psql dernier-db -n dernier` for direct access. Certificates are mounted from `dernier-db-ca`.
- **Secret Rotation:** Run `scripts/generate-dernier-sealed-secret.ts --print-values` to emit and seal fresh keys. Capture the printed `RAILS_MASTER_KEY`/`SECRET_KEY_BASE`, commit the updated sealed secret, and sync `dernier`.
- **Credentials Re-encryption:** When rotating the master key, regenerate `config/credentials.yml.enc` with the new key before deploying.
  1. Back up the existing encrypted file (`mv services/dernier/config/credentials.yml.enc services/dernier/config/credentials.yml.enc.bak`).
  2. Use the app image to re-encrypt with the new values:
     ```bash
     tmp=$(mktemp /tmp/cred-edit.XXXXXX.sh)
     cat <<'EOF' > "$tmp"
     #!/bin/sh
     cat <<'DATA' > "$1"
     # dernier credentials regenerated
     secret_key_base: <%= ENV.fetch('SECRET_KEY_BASE') %>
     DATA
     EOF
     chmod +x "$tmp"
     RAILS_MASTER_KEY=<new-master-key> \
     SECRET_KEY_BASE=<new-secret-key-base> \
     docker run --rm \
       --entrypoint /bin/bash \
       -e RAILS_MASTER_KEY \
       -e SECRET_KEY_BASE \
       -v "$tmp":/tmp/cred-editor.sh \
       -v "$(pwd)":/workspace \
       -w /workspace/services/dernier \
       registry.ide-newton.ts.net/lab/dernier:latest \
       -lc 'EDITOR=/tmp/cred-editor.sh bundle exec rails credentials:edit'
     rm "$tmp"
     ```
  3. Remove the backup once the new file is committed.
- **Cache Reset:** Flush redis via `kubectl exec -n dernier $(kubectl get pod -l app=dernier-redis -o name) -- redis-cli FLUSHALL`.

## Observability

- Rails logs stream to stdout and are collected by the platform’s fluent agent.
- CNPG and Redis exporters expose metrics consumed by the observability stack via the shared Prometheus pipeline.
- Enable verbose logging temporarily with `RAILS_LOG_LEVEL=debug` through a sealed secret rotation; remember to revert to `info`.
