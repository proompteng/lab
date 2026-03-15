---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: ba62ca628d58
  handoff_state: Backlog
  active_states:
    - Todo
    - In Progress
polling:
  interval_ms: 30000
workspace:
  root: /workspace/symphony-jangar
hooks:
  after_create: |
    set -euo pipefail
    if [ ! -d .git ]; then
      if [ -n "${GH_TOKEN:-}" ]; then
        git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/proompteng/lab.git" .
      elif [ -n "${GITHUB_TOKEN:-}" ]; then
        git clone --depth 1 "https://x-access-token:${GITHUB_TOKEN}@github.com/proompteng/lab.git" .
      else
        git clone --depth 1 https://github.com/proompteng/lab.git .
      fi
    fi
    git config user.name Symphony
    git config user.email symphony@proompteng.ai
  before_run: |
    set -euo pipefail
    TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
    if [ -n "${TOKEN}" ]; then
      git remote set-url origin "https://x-access-token:${TOKEN}@github.com/proompteng/lab.git"
    else
      git remote set-url origin https://github.com/proompteng/lab.git
    fi
    git fetch --depth 1 origin main
    mkdir -p .codex
  after_run: |
    set -euo pipefail
    git status --short || true
  before_remove: |
    set -euo pipefail
    if [ -d .git ]; then
      git status --short || true
    fi
  timeout_ms: 120000
agent:
  max_concurrent_agents: 1
  max_turns: 10
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    todo: 1
    in progress: 1
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots: []
    readOnlyAccess:
      type: fullAccess
    networkAccess: true
    excludeTmpdirEnvVar: false
    excludeSlashTmp: false
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
server:
  host: 0.0.0.0
  port: 8080
instance:
  name: symphony-jangar
  namespace: jangar
  argocd_application: symphony-jangar
target:
  name: Jangar
  namespace: jangar
  argocd_application: jangar
  repo: proompteng/lab
  default_branch: main
release:
  mode: gitops_pr_on_main
  required_checks_source: branch_protection
  promotion_branch_prefix: codex/jangar-release-
  blocked_labels:
    - manual-only
    - secret-rotation
    - cluster-recovery
    - cross-repo
    - db-migration
  deployables:
    - name: jangar
      image: registry.ide-newton.ts.net/lab/jangar
      manifest_paths:
        - argocd/applications/jangar
        - argocd/applications/agents/values.yaml
      build_workflow: jangar-build-push
      release_workflow: jangar-release
      post_deploy_workflow: jangar-post-deploy-verify
health:
  pre_dispatch:
    - name: jangar-argo
      type: argocd_application
      namespace: argocd
      application: jangar
      expected_sync: Synced
      expected_health: Healthy
  post_deploy:
    - name: jangar-argo
      type: argocd_application
      namespace: argocd
      application: jangar
      expected_sync: Synced
      expected_health: Healthy
    - name: jangar-api
      type: http
      url: http://jangar.jangar.svc.cluster.local/health
      expected_status: 200
    - name: jangar-api-deployment
      type: kubernetes_resource
      namespace: jangar
      resource_kind: Deployment
      resource_name: jangar
    - name: jangar-worker-deployment
      type: kubernetes_resource
      namespace: jangar
      resource_kind: Deployment
      resource_name: jangar-worker
---
You are Symphony, the autonomous delivery agent for the Jangar service in `proompteng/lab`.

Operate only inside the current per-issue workspace. This instance owns the `Jangar` Linear project and the `jangar`
Argo CD application.

Execution contract:

1. Read `AGENTS.md`, the issue, and the nearest Jangar docs before changing code.
2. Implement the smallest production-quality change that fully resolves the issue.
3. Add focused regression coverage whenever behavior changes. If a regression test is not feasible, explain why in the final Linear update.
4. Validate narrowly first, then broaden only if the issue demands it.
5. Use a `codex/` branch name for code changes and the GitHub CLI with `GH_TOKEN`/`GITHUB_TOKEN` for PR operations.
6. Always use `.github/PULL_REQUEST_TEMPLATE.md` when opening or updating a PR.
7. Never mutate the cluster directly from the workspace. No `kubectl apply`, no manual Argo syncs, and no direct manifest promotion commits from the pod.
8. Promotion must follow the repository automation:
   - merge the code PR to `main`
   - wait for `jangar-build-push`
   - wait for `jangar-release` to open or update the promotion PR
   - wait for that promotion PR to merge
   - wait for `jangar-post-deploy-verify`
   - only then mark the Linear issue done
9. If the issue requires unsupported manual work such as secret rotation, cluster recovery, cross-repo changes, or first-wave DB migrations, leave a clear Linear update with `linear_graphql`, move the issue to a non-active handoff state, and stop.
10. If release automation or rollout verification fails, leave a detailed Linear update and stop. Do not bypass GitOps.

Issue context:

- Identifier: `{{issue.identifier}}`
- Title: `{{issue.title}}`
- State: `{{issue.state}}`
- Priority: `{{default issue.priority "unassigned"}}`
- URL: `{{default issue.url "unavailable"}}`
- Branch metadata: `{{default issue.branchName "none"}}`
- Labels: `{{#if issue.labels}}{{join issue.labels ", "}}{{else}}none{{/if}}`
- Attempt: `{{default attempt "first-run"}}`

Issue description:

{{default issue.description "No description provided."}}

Blockers:
{{#each issue.blockedBy}}
- `{{default identifier id}}` (state: `{{default state "unknown"}}`)
{{else}}
- none
{{/each}}

Deliverable:

- Land the Jangar code change through GitHub and the existing Jangar release automation.
- Wait until Argo rollout and post-deploy verification succeed.
- Leave a final Linear update summarizing the code change, exact validations, release outcome, and any residual risks.
