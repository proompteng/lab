# Hermes production

Hermes is the production runtime for the Tuslagch assistant. GitOps exposes its authenticated API through the cluster-local
Service and a private Tailscale Ingress; neither path bypasses bearer authentication. Keep the manual application unsynced
until the live NetworkPolicy enforcement probe passes. Hermes and OpenClaw must never use the Discord token concurrently.

## Release and supply chain

- Hermes Agent release: `v2026.8.27` (Hermes `0.20.6`), upstream commit
  `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`.
- Upstream multi-architecture index: `sha256:e0df6adebddf29b91112aefc999d4aaf6846c9eb544faca5672a16a13590ff79`.
- Upstream amd64 manifest: `sha256:5f23552e16589d291099cd8041233e6200197d225e4b28b22a0463e732d4b843`.
- Upstream amd64 SLSA provenance manifest: `sha256:450e5016e0a278396f097abbb8a2f54418e0980dd09e60dbf5f48eab96e06a9c`.
  Its subject is the exact amd64 manifest and its BuildKit provenance records GitHub Actions run `33070373247` and source
  revision `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`.
- Mirrored amd64 manifest: `registry.ide-newton.ts.net/lab/hermes-agent@sha256:5f23552e16589d291099cd8041233e6200197d225e4b28b22a0463e732d4b843`.
- Squid egress proxy: `docker.io/ubuntu/squid:6.6-24.04_edge` pinned by digest in `egress-proxy.yaml`.
- Lab toolchain: the dedicated multi-architecture Nix OCI image is pinned by index digest in the Kargo-managed StatefulSet reference;
  it is restricted to Node `24.11.1`, Bun/Bunx `1.4.0`, Go `1.25.5`, Helm `3.19.1`, Kustomize `5.8.0`, kubeconform `0.7.0`,
  ShellCheck `0.11.0`, jq `1.8.1`, and yq `4.49.2`.

All runtime image references are immutable digests. A merge to `main` starts the Hermes toolchain image build; once the
multi-architecture image is published, Kargo creates Freight and automatically promotes Stage `lab-delivery/hermes-toolchain`.
Kargo copies the exact source commit into `kargo/hermes-toolchain`, updates the StatefulSet image reference, commits and
pushes that deployment branch, and Argo CD reconciles the branch. Freight, Stage, and the resulting branch commit are the
deployment record. There is no digest bump PR, release PR, manual SHA edit, or manual Argo sync.

The StatefulSet is the only committed surface that owns the current Hermes toolchain digest. Do not copy that ephemeral
digest into documentation, scripts, or PR descriptions; derive it from the Kargo-managed StatefulSet or Freight when
validating a rollout.

## Runtime boundaries

- The gateway and independent backup CronJob run as UID/GID `10000`; Squid runs as UID/GID `13`.
- Root filesystems are read-only, all Linux capabilities are dropped, and seccomp is `RuntimeDefault`. Only the gateway Pod
  receives a rotating Kubernetes service-account token; backup, migration, restore, and egress-proxy Pods explicitly disable
  token mounting.
- The namespace enforces the Kubernetes `restricted` Pod Security profile.
- Default-deny NetworkPolicies permit the gateway to reach only cluster DNS, the Kubernetes API service and its pinned
  control-plane endpoints, Flamingo, and the dedicated Squid proxy once a compatible policy engine is present. Flannel
  alone does not enforce these objects; the runbook's disposable live probe must pass before the first sync.
- Squid permits HTTPS `CONNECT` to public destinations. Squid ACLs and NetworkPolicy both block private, tailnet, loopback,
  link-local/metadata, multicast, and reserved destination ranges; the gateway has no direct public egress path.
- Hermes receives a digest-pinned Kubernetes 1.35 `kubectl` binary through an OCI image volume. Its custom ClusterRole has
  only `get`, `list`, and `watch`, excludes core Secrets and interactive Pod subresources, and is bound cluster-wide only to
  the `hermes` ServiceAccount. Bootstrap writes a non-secret kubeconfig that follows the rotating projected token by file
  path rather than persisting token material.
- Hermes receives the curated Lab toolchain through a second read-only OCI image volume. Only its `/bin` facade and
  `/nix/store` closure are mounted; the image does not include Nix, a container engine, GitHub credentials, `kubectl`, or
  any additional Kubernetes authority. Bootstrap fails closed unless every tool reports the repository-pinned version.
- The API and Exa keys come from the `infra/hermes-runtime` 1Password item through narrowly mapped External Secrets. No
  secret is committed to Git.
- The `tuslagch` GitHub OAuth token is committed only as a namespace-scoped SealedSecret ciphertext. Only the bootstrap init
  container receives `GH_TOKEN`; it creates mode-`0600` GitHub CLI auth files in a per-Pod `emptyDir` shared read-only with
  the gateway. The pinned Hermes runtime intentionally strips `GH_TOKEN` and `GITHUB_TOKEN` from model-authored terminal
  subprocesses, so environment-only authentication is insufficient. The token never enters the gateway environment, data
  PVC, backups, Git config, or a rendered manifest.
- GitHub token rotation must reseal `hermes-github-auth` and increment the StatefulSet's
  `hermes.proompteng.ai/github-auth-revision` annotation so the Secret-backed credential takes effect in a new Pod.
- Bootstrap downloads GitHub CLI `2.96.0` from its official release, enforces SHA-256
  `83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60`, caches the verified archive, and recreates the
  `tuslagch` Git identity, GitHub CLI authentication, and `gh auth git-credential` helper on every start. Bootstrap fails
  closed unless `gh api user` returns `tuslagch` and repository permission is `ADMIN`.
- The gateway process keeps the upstream `/usr/local/bin/node` `v26.5.1` ahead of the Lab toolchain so Hermes runs with its
  release-pinned Node major. The immutable `/etc/profile.d/hermes-tools.sh` deliberately restores `/opt/tools`,
  `/opt/lab-toolchain/bin`, and the pinned Hermes paths after Debian's login profile resets `PATH`; Hermes explicitly
  sources it while capturing each terminal session, so model-authored terminals retain repository-pinned Node `24.11.1`
  and bare `gh` and `kubectl` resolve consistently from API and Discord terminals.
- API key rotation requires a bounded Secret refresh, gateway Pod restart, and old-key rejection/new-key acceptance proof.
- The API is available through the cluster-local Service and the private tailnet URL
  `https://hermes.ide-newton.ts.net`; both require bearer authentication for model requests and detailed health.
- Native Exa-backed `web_search` and `web_extract` are enabled for CLI, authenticated API, and Discord sessions. The
  authenticated Exa MCP server is restricted to its read-only `web_search_exa` and `web_fetch_exa` tools. Plugins,
  delegation, cron, hooks, and speech-to-text remain disabled; manual approvals and unconditional deny rules remain
  enabled.
- Only `/opt/data/workspace/tuslagch`, Hermes-managed memory, and Hermes-managed skills are writable agent surfaces.
- Bootstrap maintains `proompteng/lab` at `/opt/data/workspace/tuslagch/lab`. Initial clone and clean-main refresh remain
  credential-free and use bounded retries for transient pod-network startup races; interactive runtime Git and GitHub CLI
  operations use the sealed `tuslagch` identity. Clean `main` checkouts fast-forward on restart; dirty worktrees and non-main
  branches are preserved. Both the gateway's documented `terminal.cwd` and the container working directory point at this
  repository root.

## Private tailnet API

The `hermes-tailscale` layer-7 Ingress exposes the gateway only to authorized tailnet clients. The Tailscale operator
terminates TLS for `https://hermes.ide-newton.ts.net` and forwards HTTP to the cluster-internal `hermes` Service on named
port `api` / `8642`. It does not enable Funnel or create a public Ingress. The gateway's existing bearer authentication
remains mandatory after Tailscale has authorized network access.

- Canonical URL: `https://hermes.ide-newton.ts.net`
- MagicDNS hostname: `hermes`
- Kubernetes Ingress: `hermes-tailscale`
- Backend: `hermes.hermes.svc.cluster.local:8642`

The gateway NetworkPolicy admits port `8642` only from the exact operator-managed proxy labeled for
`hermes/hermes-tailscale` and from existing same-namespace callers. Ordinary Pods in other namespaces remain denied.
Use the fully qualified URL so TLS validates against the tailnet certificate; an unauthenticated request to
`/health/detailed` must return `401`.

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
