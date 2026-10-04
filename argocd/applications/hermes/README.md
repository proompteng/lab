# Hermes production

Hermes serves the Tuslagch assistant through its native web dashboard, authenticated cluster-local API, and private Tailscale Ingress.
GitOps enables one gateway, one dashboard, one egress proxy, daily backups, and rollout alerts. Before restoring service, pass the live
NetworkPolicy enforcement probe. Hermes and OpenClaw must never use the Discord token concurrently.

## Release and supply chain

- Hermes Agent release: `v2026.9.24` (Hermes `0.21.5`), upstream commit
  `f97608f178d1ffeca59860195ab7da295f7c8e5f`.
- Upstream multi-architecture index: `sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`.
- Upstream amd64 manifest: `sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283`.
- Upstream amd64 SLSA provenance manifest: `sha256:c9d52f53bd421aedcd1bc78acbaa2e1c60580d259259e9ee5bd6713a2acb094c`.
  Its subject is the exact amd64 manifest and its BuildKit provenance records GitHub Actions run `35985600604` and source
  revision `f97608f178d1ffeca59860195ab7da295f7c8e5f`.
- Mirrored amd64 manifest: `registry.ide-newton.ts.net/lab/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283`.
- Squid egress proxy: `docker.io/ubuntu/squid:6.6-24.04_edge` pinned by digest in `egress-proxy.yaml`.
- Lab toolchain: the dedicated multi-architecture Nix OCI image is pinned by index digest in the Kargo-managed StatefulSet reference;
  it is restricted to Node `24.11.1`, Bun/Bunx `1.4.2`, Go `1.25.5`, Helm `3.19.1`, Kustomize `5.8.0`, kubeconform `0.7.0`,
  ShellCheck `0.11.0`, jq `1.8.1`, and yq `4.49.2`.

The pinned upstream release is mirrored by the dispatchable `hermes-agent-mirror` workflow. That workflow runs only from
`main`, verifies the complete upstream index, amd64/arm64 platforms, attached SLSA manifest, matching amd64 subject, and
the fetched in-toto predicate/source revision before copying the immutable index to
`registry.ide-newton.ts.net/lab/hermes-agent:v2026.9.24-amd64`. The toolchain workflow waits for the private immutable agent manifest before publishing a
Kargo-eligible image. The workflow never writes a Kargo tag or the Kargo-managed toolchain digest.

All runtime image references are immutable digests. Relevant merges to `main` build the Hermes toolchain image. After
successful publication, Kargo creates Freight and automatically promotes Stage `lab-delivery/hermes-toolchain`.
Kargo copies the selected source into `kargo/hermes-toolchain` and updates the immutable toolchain reference. Argo reconciles
that deployment branch. Freight, Stage, and the resulting branch commit are the deployment record.
There is no digest bump PR, release PR, manual SHA edit, or manual Argo sync.

The StatefulSet is the only committed surface that owns the current Hermes toolchain digest. Do not copy that ephemeral
digest into documentation, scripts, or PR descriptions; derive it from the Kargo-managed StatefulSet or Freight when
validating a rollout.

## Runtime boundaries

- The gateway, dashboard, and independent backup CronJob run as UID/GID `10000`; Squid runs as UID/GID `13`.
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
  the gateway and dashboard. The pinned Hermes runtime intentionally strips `GH_TOKEN` and `GITHUB_TOKEN` from model-authored terminal
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
  native web tools are the sole Exa integration. Session search and skills are available on all three surfaces. The
  bundled `security-guidance` plugin warns about risky file writes. Delegation, agent scheduling, Kanban dispatch, custom
  hooks, and speech-to-text remain disabled. The bundled dashboard password provider, manual approvals, and unconditional
  deny rules remain enabled.
- Only `/opt/data/workspace/tuslagch`, Hermes-managed memory, and Hermes-managed skills are writable agent surfaces.
- Bootstrap maintains `proompteng/lab` at `/opt/data/workspace/tuslagch/lab`. Initial clone and clean-main refresh remain
  credential-free and use bounded retries for transient pod-network startup races; interactive runtime Git and GitHub CLI
  operations use the sealed `tuslagch` identity. Clean `main` checkouts fast-forward on restart; dirty worktrees and non-main
  branches are preserved. Both the gateway's documented `terminal.cwd` and the container working directory point at this
  repository root.

## Private tailnet dashboard and API

Open `https://hermes.ide-newton.ts.net` to use the built-in Hermes dashboard and chat. Sign in as `tuslagch` with the
`API_SERVER_KEY` field from the existing `infra/hermes-runtime` 1Password item. The dashboard hashes that Secret-backed
password in memory. Its session-signing key is process-local, so sign in again after a dashboard restart. API key rotation
also rotates the dashboard password and requires a Pod restart.

The dashboard runs `hermes dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build` using the frontend bundled in the
same pinned Hermes image as the gateway. Kubernetes supervises both containers independently. They share `/opt/data`,
the terminal toolchain, read-only GitHub CLI authentication, and the native HTTP gateway health probe. Their process namespaces remain separate. The dashboard has no Discord token and does not start a second gateway.

Configuration, identity files, an empty runtime `.env`, and the `.managed` marker are read-only GitOps mounts.
`HERMES_MANAGED=gitops` also enables native managed-install guards. A read-only empty profiles directory prevents
creating secondary runtime profiles; the retained installation had no secondary profiles before this mount. The complete setting inventory and profile rationale
are in [configuration.md](configuration.md). Manage credentials through the existing External Secrets and sealed identity paths. Edit configuration through the repository. Dashboard chat,
session history, memory, and skills use the retained Hermes data PVC. Use GitOps for gateway lifecycle changes.

The `hermes-tailscale` Ingress terminates TLS and routes `/` to named port `dashboard` / `9119`. The more specific `/v1`
and `/health` prefixes retain the gateway API on named port `api` / `8642` and require its existing bearer authentication.
The dashboard owns the tailnet `/api` routes. The cluster-local API at `http://hermes.hermes.svc.cluster.local:8642` retains
all gateway routes, including its `/api` endpoints. There is no Funnel or public Ingress.

The gateway NetworkPolicy admits API traffic from the exact operator-managed proxy labeled for `hermes/hermes-tailscale`
and existing same-namespace callers. Only that exact Tailscale proxy may reach the dashboard port. The dashboard trusts
forwarding headers from the bounded cluster Pod CIDR `10.244.0.0/16`; NetworkPolicy restricts those incoming connections
to the selected proxy. The canonical public URL enables the native remote authentication gate and HTTPS WebSocket flow.
An unauthenticated dashboard `/api/sessions` or gateway `/health/detailed` request must return `401`.

## State and recovery

- `data-hermes-0`: 50 Gi RBD PVC for Hermes state, sessions, memories, skills, and workspace.
- `backups-hermes-0`: 100 Gi RBD PVC for daily WAL-safe Hermes backup archives and SHA-256 sidecars.
- StatefulSet PVC retention is `Retain` on delete and scale-down.
- Migration Jobs mount the stable, read-only `hermes-operation-config` generated from the same production `config.yaml` as
  the gateway, so previews, memory limits, reports, and restore points use production settings rather than Hermes defaults.
- The backup wrapper refuses to publish an archive containing any nonempty `.env` credential file. Failed pending archives are removed.
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
