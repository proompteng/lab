# AgentRun workspace cache

`agents-workspace-cache` runs on `turin` and `talos-192-168-1-85`, not `talos-192-168-1-194`. It uses the
Kargo-selected runner image and is the only workload with write access to the dedicated host directory
`/var/lib/agents-workspace-cache`. Don't put unrelated files or nested mounts there.

Every five minutes the refresher checks GitHub using `github-token` and updates the bare
`git/proompteng/lab.git` mirror. It fetches and prunes in an inactive slot and publishes by atomic rename, leaving
the previous slot available for readers. The same two-slot scheme bounds Bun cache retention. The Bun cache is
rebuilt from `main` when `bun.lock` or the Bun version changes. It warms only the production dependencies needed by
`bun run context:retrieve`, not the whole monorepo.

Set `controllers.env.vars.AGENTS_AGENT_RUNNER_SHARED_CACHE_HOST_PATH` in the Helm values (or `env.vars` for a
single Deployment). Unset it to disable the mount for new Jobs. The production Agents values opt in for standard
Codex Jobs targeting `https://github.com/proompteng/lab`. Those Jobs mount the cache read-only at
`/var/cache/agents-shared`. Job scheduling doesn't change; on a node without a cache, kubelet creates an empty
directory and checkout proceeds normally. An unavailable, invalid or older-than-15-minute mirror is skipped.

Cached clones borrow objects for a shallow checkout of the requested base, using the resolved mirror slot rather
than the rotating symlink. They dissociate during clone so the Git directory survives slot recycling. A failed
reference clone retries from GitHub without the mirror. A fresh clone reuses the refs GitHub already supplied:
only the shallow cache path needs a separate fetch for a different head branch. Existing checkouts still fetch
their requested refs.

Before the first turn, the runner attempts a bounded offline install of `memories` into private `node_modules`
without running lifecycle scripts. Temporary links let Bun read the shared cache without copying it into the Job's
writable cache. A miss retries once with the Job's normal writable cache and registry. If that also fails, the
runner warns and starts the turn anyway. Other workspaces still use the normal explicit dependency installation.

Standard Lab Codex Jobs with at least an 8 GiB `ephemeral-storage` request and 16 GiB limit put generated
`/workspace` and `/opt/bun/install/cache` on local disk whether or not the cache is available. Git objects,
`node_modules`, and writable Bun downloads no longer occupy tmpfs on those Jobs; they count toward the Pod's
ephemeral-storage budget instead. `/tmp` and the generated Codex auth home stay in RAM. Lower or missing disk
budgets and explicit workload mounts retain their existing behavior.

After a GitOps rollout, use `kubectl -n agents get ds agents-workspace-cache` to check readiness on both build
nodes and `kubectl -n agents logs ds/agents-workspace-cache -c refresh --tail=50` to diagnose a failed refresh.
For cached and uncached Jobs, compare the `startup_phase` events in Pod logs or the retained runner log:
`git_checkout` and `bun_bootstrap` include their source or outcome, and `first_turn_started.elapsedMs` measures
time from runner start to the first accepted turn, excluding scheduling and image pulls. Check mounted storage
with `df -T -B1 /workspace /opt/bun/install/cache /tmp /root/.codex` after a representative install and compare
the used bytes on tmpfs mounts. Verify `bun run context:retrieve` works on the first turn. To disable the cache,
remove the controller opt-in; existing Jobs retain their mounts until they finish.
