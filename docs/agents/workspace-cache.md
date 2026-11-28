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

Cached clones borrow objects for the requested base branch and dissociate before the turn starts. Fetch and
checkout still use the requested refs from GitHub, not cached refs as authority. Before the first turn, the runner
attempts a bounded offline install of `memories` into private `node_modules` without running lifecycle scripts.
Temporary links let Bun read the cache without copying it into RAM. A miss retries once with the Job's normal
writable cache and registry. If that also fails, the runner warns and starts the turn anyway. Other workspaces
still use the normal explicit dependency installation.

After a GitOps rollout, use `kubectl -n agents get ds agents-workspace-cache` to check readiness on both build
nodes and `kubectl -n agents logs ds/agents-workspace-cache -c refresh --tail=50` to diagnose a failed refresh.
Verify a newly launched eligible Job has a read-only mount and can run `bun run context:retrieve` on its first
turn. To roll back, remove the controller opt-in first; existing Jobs retain their mounts until they finish.
