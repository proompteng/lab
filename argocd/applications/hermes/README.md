# Hermes production

Hermes is the planned production runtime for the Tuslagch assistant. The initial GitOps state exposes only the authenticated
cluster-local API. Keep the manual application unsynced until the live NetworkPolicy enforcement probe passes. Discord
remains disabled until migration and API canary gates pass; the cutover is a separate reviewed change so Hermes and OpenClaw
never use the Discord token concurrently.

## Release and supply chain

- Hermes Agent release: `v2026.7.7.2` (Hermes `0.18.2`), upstream commit
  `9de9c25f620ff7f1ce0fd5457d596052d5159596`.
- Upstream multi-architecture index: `sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973`.
- Mirrored amd64 manifest: `registry.ide-newton.ts.net/lab/hermes-agent@sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a`.
- Squid egress proxy: `docker.io/ubuntu/squid:6.6-24.04_edge` pinned by digest in `egress-proxy.yaml`.

All runtime image references are immutable digests. Updating Hermes requires a new release review, amd64 mirror, rootless
smoke test, manifest change, and normal CI/Codex review.

## Runtime boundaries

- The gateway and independent backup CronJob run as UID/GID `10000`; Squid runs as UID/GID `13`.
- Root filesystems are read-only, all Linux capabilities are dropped, and seccomp is `RuntimeDefault`. Only the gateway Pod
  receives a rotating Kubernetes service-account token; backup, migration, restore, and egress-proxy Pods explicitly disable
  token mounting.
- The namespace enforces the Kubernetes `restricted` Pod Security profile.
- Default-deny NetworkPolicies permit the gateway to reach only cluster DNS, the Kubernetes API service and its pinned
  control-plane endpoints, Flamingo, and the allowlisted Squid proxy once a compatible policy engine is present. Flannel
  alone does not enforce these objects; the runbook's disposable live probe must pass before the first sync.
- Squid permits HTTPS `CONNECT` only to Discord-owned domains and GitHub, and blocks other destinations plus private,
  tailnet, metadata, and multicast ranges.
- Hermes receives a digest-pinned Kubernetes 1.35 `kubectl` binary through an OCI image volume. Its custom ClusterRole has
  only `get`, `list`, and `watch`, excludes core Secrets and interactive Pod subresources, and is bound cluster-wide only to
  the `hermes` ServiceAccount.
- The API key comes from `onepassword-infra` through External Secrets. No secret is committed to Git.
- API key rotation requires a bounded Secret refresh, gateway Pod restart, and old-key rejection/new-key acceptance proof.
- The API is cluster-local and requires bearer authentication for model requests and detailed health.
- Plugins, MCP servers, delegation, cron, hooks, speech-to-text, and Discord are disabled for the initial canary.
- Only `/opt/data/workspace/tuslagch`, Hermes-managed memory, and Hermes-managed skills are writable agent surfaces.
- Bootstrap maintains a credential-free `proompteng/lab` checkout at `/opt/data/workspace/tuslagch/lab`. Clean `main`
  checkouts fast-forward on restart; dirty worktrees and non-main branches are preserved.

## State and recovery

- `data-hermes-0`: 50 Gi RBD PVC for Hermes state, sessions, memories, skills, and workspace.
- `backups-hermes-0`: 100 Gi RBD PVC for daily WAL-safe Hermes backup archives and SHA-256 sidecars.
- StatefulSet PVC retention is `Retain` on delete and scale-down.
- Migration Jobs mount the stable, read-only `hermes-operation-config` generated from the same production `config.yaml` as
  the gateway, so previews, memory limits, reports, and restore points use production settings rather than Hermes defaults.
- The daily backup CronJob retains the latest 14 verified archives and retries failures independently from the gateway. Its
  first scheduled success and subsequent last-success timestamp are monitored on a 26-hour window without removing a
  healthy API endpoint.
- The pinned backup process opens SQLite databases in read-only mode, but its data PVC mount is write-capable because WAL
  readers must create or update shared-memory sidecars. The Pod has no service-account token and the wrapper rejects any
  SQLite safe-copy fallback, verifies every archived database with `PRAGMA quick_check`, then publishes the SHA-256 sidecar.
- OpenClaw's VM and PVC remain intact and stopped for at least 14 days after cutover. Do not run `hermes claw cleanup` during
  the rollback window.

Operational gates, migration commands, cutover, rollback, and evidence requirements are in
`docs/runbooks/hermes-production-rollout.md`.

## Render and validate

```bash
kustomize build argocd/applications/hermes >/tmp/hermes.yaml
nix develop -c scripts/kubeconform.sh argocd/applications/hermes /tmp/hermes.yaml
bun run scripts/hermes/validate-production.ts
shellcheck argocd/applications/hermes/*.sh
```
