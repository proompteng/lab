# Synthesis Deep Alpha Scheduled AgentRun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitOps-managed Synthesis AgentRun that runs every 3 hours, researches short-term 2-3 week options strategy candidates with technical-analysis entry timing, and posts strict synthesized items to Synthesis.

**Architecture:** Keep the resources owned by the Synthesis Argo CD app under `argocd/applications/synthesis`, but run the AgentRun primitives in the existing `agents` namespace where the controller, `agents-sa`, and `codex-auth` already work. Reflect the existing `synthesis/synthesis-env` secret into `agents`, inject `SYNTHESIS_API_TOKEN` into the Codex runner, and connect Codex to the in-cluster Synthesis MCP endpoint through an input-file MCP proxy.

**Tech Stack:** Argo CD/Kustomize, Agents CRDs (`AgentProvider`, `Agent`, `ImplementationSpec`, `AgentRun`, `Schedule`), Kubernetes reflector, Bitnami SealedSecret template annotations, Codex app-server runner, Synthesis MCP.

---

## File Structure

- Modify `argocd/applications/synthesis/kustomization.yaml` to include an `agents-domain` child kustomization.
- Modify `argocd/applications/synthesis/synthesis-env-sealedsecret.yaml` to allow reflector to mirror `SYNTHESIS_API_TOKEN` into `agents`.
- Create `argocd/applications/synthesis/agents-domain/kustomization.yaml` to scope Synthesis-owned agent resources to the `agents` namespace.
- Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agentprovider.yaml` for the Codex provider, Synthesis MCP proxy, token env, and artifacts.
- Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agent.yaml` for the Agent policy allowlist.
- Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-implspec.yaml` for the research/posting prompt.
- Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agentrun-template.yaml` for the reusable schedule target.
- Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-schedule.yaml` for the every-3-hour Cron schedule.

## Task 1: Wire Synthesis App Ownership And Secret Reflection

**Files:**
- Modify: `argocd/applications/synthesis/kustomization.yaml`
- Modify: `argocd/applications/synthesis/synthesis-env-sealedsecret.yaml`
- Create: `argocd/applications/synthesis/agents-domain/kustomization.yaml`

- [ ] **Step 1: Add the Synthesis agents-domain child kustomization**

Add this resource entry to `argocd/applications/synthesis/kustomization.yaml`:

```yaml
resources:
  - postgres-cluster.yaml
  - objectbucketclaim.yaml
  - synthesis-env-sealedsecret.yaml
  - deployment.yaml
  - service.yaml
  - tailscale-service.yaml
  - networkpolicy.yaml
  - agents-domain
```

- [ ] **Step 2: Reflect the Synthesis MCP token into the agents namespace**

Update `argocd/applications/synthesis/synthesis-env-sealedsecret.yaml` so the generated `Secret/synthesis-env` carries reflector annotations:

```yaml
spec:
  template:
    metadata:
      annotations:
        reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
        reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: agents
        reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
        reflector.v1.k8s.emberstack.com/reflection-auto-namespaces: agents
      creationTimestamp: null
      name: synthesis-env
      namespace: synthesis
```

- [ ] **Step 3: Create the agents-domain kustomization**

Create `argocd/applications/synthesis/agents-domain/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: agents
resources:
  - synthesis-deep-alpha-agentprovider.yaml
  - synthesis-deep-alpha-agent.yaml
  - synthesis-deep-alpha-implspec.yaml
  - synthesis-deep-alpha-agentrun-template.yaml
  - synthesis-deep-alpha-schedule.yaml
```

- [ ] **Step 4: Render the Synthesis app**

Run:

```bash
kustomize build argocd/applications/synthesis >/tmp/synthesis-render.yaml
```

Expected: command exits `0`, and `/tmp/synthesis-render.yaml` contains resources in both `synthesis` and `agents`.

- [ ] **Step 5: Check reflected-secret annotations render**

Run:

```bash
rg -n "reflection-allowed|reflection-auto|name: synthesis-env|namespace: agents|namespace: synthesis" /tmp/synthesis-render.yaml
```

Expected: the rendered SealedSecret template contains reflector annotations for `agents`, and the agents-domain resources render with `namespace: agents`.

- [ ] **Step 6: Commit**

```bash
git add argocd/applications/synthesis/kustomization.yaml \
  argocd/applications/synthesis/synthesis-env-sealedsecret.yaml \
  argocd/applications/synthesis/agents-domain/kustomization.yaml
git commit -m "feat(synthesis): wire agentrun resources into gitops app"
```

## Task 2: Add The Synthesis Codex Provider

**Files:**
- Create: `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agentprovider.yaml`

- [ ] **Step 1: Create the AgentProvider**

Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agentprovider.yaml`:

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentProvider
metadata:
  name: synthesis-deep-alpha
spec:
  binary: /usr/local/bin/agent-runner
  adapter:
    type: codex-app-server
    codex:
      model: gpt-5.3-codex-spark
      effort: xhigh
      sandbox: danger-full-access
      approval: never
      cwd: /workspace/lab
      threadConfig:
        mcp_servers:
          synthesis:
            command: node
            args:
              - /root/.codex/synthesis-mcp-proxy.mjs
        web_search: live
  argsTemplate: []
  secretEnv:
    - name: SYNTHESIS_API_TOKEN
      secretName: synthesis-env
      key: SYNTHESIS_API_TOKEN
  envTemplate:
    CODEX_LOG_LEVEL: info
    AGENT_RUN_NAME: "{{agentRun.name}}"
    AGENT_RUN_NAMESPACE: "{{agentRun.namespace}}"
    CODEX_CONFIG: /root/.codex/config.toml
    CODEX_MAX_SESSION_ATTEMPTS: "3"
    CODEX_MODEL: gpt-5.3-codex-spark
    CODEX_MODEL_FALLBACKS: gpt-5.5,gpt-5.4,gpt-5.4-mini,gpt-5.2-codex,gpt-5-codex
    HOME: /root
    SYNTHESIS_MCP_URL: http://synthesis.synthesis.svc.cluster.local:3000/mcp
  inputFiles:
    - path: /root/.codex/config.toml
      content: |-
        model = "gpt-5.3-codex-spark"
        model_reasoning_summary = "none"
        model_reasoning_effort = "xhigh"
        model_verbosity = "medium"
        approval_policy = "never"
        sandbox_mode = "danger-full-access"
        web_search = "live"
        suppress_unstable_features_warning = true

        [features]
        undo = true
        enable_request_compression = true
        apply_patch_freeform = true
        unified_exec = true
        shell_snapshot = true
        steer = true
        multi_agent = true
        child_agents_md = true
        collaboration_modes = true
        responses_websockets = false
        goals = true

        [shell_environment_policy]
        ignore_default_excludes = true

        [projects."/workspace/lab"]
        trust_level = "trusted"

        [projects."/root"]
        trust_level = "trusted"

        [mcp_servers.synthesis]
        command = "node"
        args = ["/root/.codex/synthesis-mcp-proxy.mjs"]
    - path: /root/.codex/synthesis-mcp-proxy.mjs
      content: |-
        #!/usr/bin/env node

        import readline from 'node:readline'

        const endpoint = process.env.SYNTHESIS_MCP_URL || 'http://synthesis.synthesis.svc.cluster.local:3000/mcp'
        const token = process.env.SYNTHESIS_API_TOKEN || process.env.SYNTHESIS_MCP_TOKEN || ''

        const buildError = (id, code, message, data) => ({
          jsonrpc: '2.0',
          id,
          error: {
            code,
            message,
            ...(data == null ? {} : { data }),
          },
        })

        const getId = (message) => {
          if (!message || typeof message !== 'object') return null
          const id = message.id
          return typeof id === 'string' || typeof id === 'number' || id === null ? id : null
        }

        const writeJson = (message) => {
          process.stdout.write(`${JSON.stringify(message)}\n`)
        }

        const forward = async (line) => {
          if (!line.trim()) return

          let message
          try {
            message = JSON.parse(line)
          } catch {
            writeJson(buildError(null, -32700, 'Parse error'))
            return
          }

          const id = getId(message)
          const headers = {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          }
          if (token) headers.authorization = `Bearer ${token}`

          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(message),
            })
            const body = await response.text()

            if (!body.trim()) return
            if (!response.ok) {
              writeJson(buildError(id, -32000, `Synthesis MCP HTTP ${response.status}`, body.slice(0, 1000)))
              return
            }

            for (const event of body.split(/\n\n+/)) {
              const dataLine = event.split(/\r?\n/).find((eventLine) => eventLine.startsWith('data:'))
              if (dataLine) {
                process.stdout.write(`${dataLine.slice(5).trim()}\n`)
                continue
              }
              process.stdout.write(`${body.trim()}\n`)
              break
            }
          } catch (error) {
            writeJson(buildError(id, -32000, 'Synthesis MCP proxy failed', error instanceof Error ? error.message : error))
          }
        }

        const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
        input.on('line', (line) => {
          void forward(line)
        })
  outputArtifacts:
    - name: synthesis-deep-alpha-report
      path: /workspace/.agentrun/synthesis-deep-alpha/report.md
      key: synthesis/deep-alpha/{{ agentRun.name }}/report.md
    - name: runner-log
      path: /workspace/.agent/runner.log
    - name: runner-status
      path: /workspace/.agent/status.json
```

- [ ] **Step 2: Render and inspect provider inputs**

Run:

```bash
kustomize build argocd/applications/synthesis >/tmp/synthesis-render.yaml
rg -n "kind: AgentProvider|name: synthesis-deep-alpha|SYNTHESIS_MCP_URL|synthesis-mcp-proxy.mjs|secretName: synthesis-env" /tmp/synthesis-render.yaml
```

Expected: all five patterns are present in the rendered manifest.

- [ ] **Step 3: Commit**

```bash
git add argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agentprovider.yaml
git commit -m "feat(synthesis): add deep alpha codex provider"
```

## Task 3: Add Agent Policy And Research Prompt

**Files:**
- Create: `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agent.yaml`
- Create: `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-implspec.yaml`

- [ ] **Step 1: Create the Agent**

Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agent.yaml`:

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: Agent
metadata:
  name: synthesis-deep-alpha-agent
spec:
  providerRef:
    name: synthesis-deep-alpha
  defaults:
    systemPromptRef:
      kind: ConfigMap
      name: codex-agent-system-prompt
      key: system-prompt.md
  security:
    allowedSecrets:
      - codex-auth
      - synthesis-env
    allowedServiceAccounts:
      - agents-sa
```

- [ ] **Step 2: Create the ImplementationSpec**

Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-implspec.yaml`:

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: ImplementationSpec
metadata:
  name: synthesis-deep-alpha-options-v1
spec:
  summary: Scheduled deep-alpha options research for Synthesis
  source:
    provider: custom
    externalId: synthesis-deep-alpha-options-v1
  labels:
    - synthesis
    - deep-alpha
    - options
    - technical-analysis
  acceptanceCriteria:
    - Start a Synthesis MCP run before research submission.
    - Submit at least three strict Synthesis items through synthesis_submit_batch.
    - Each item includes sourcePosts, factChecks, dedupeKey, score, confidence, and topicTags.
    - Each strategy states a 2-3 week intended hold window, entry timing, invalidation, and risk.
    - The run places no trades and uses no broker/order-entry tools.
  text: |-
    You are the scheduled Synthesis deep-alpha options research agent.

    Objective:
    - Every run must research current high-liquidity US equity or ETF option opportunities for a 2-3 week hold.
    - Produce short-term strategy candidates with technical-analysis entry timing, catalyst context, risk/invalidation, and confidence.
    - Post the output to Synthesis through the Synthesis MCP server.

    Hard safety rules:
    - This is research content only, not personalized financial advice.
    - Do not place trades, route orders, call broker/order-entry tools, or suggest account-specific sizing.
    - Do not ask for secrets.
    - Do not edit repository files.
    - If live option-chain/liquidity data is not directly verifiable, mark that limitation clearly in the submitted item and reduce confidence.

    Required workflow:
    1. Use Synthesis MCP `synthesis_start_run` with:
       - source: `scheduled-agentrun:synthesis-deep-alpha-options`
       - interests: `["deep-alpha","options","technical-analysis","equities","2-3-week-hold"]`
       - notes: current UTC timestamp, market session context, and that this is a scheduled run.
    2. Gather current market evidence with live web search and any available market-data tools.
    3. Select 3 to 6 candidates. Prefer liquid large-cap equities or ETFs. Avoid obscure tickers.
    4. For each candidate, require:
       - ticker or theme
       - directional thesis
       - catalyst or market regime reason
       - technical setup using price trend, support/resistance, moving averages, volume, relative strength, or momentum
       - concrete entry timing trigger such as reclaim, pullback, breakout retest, close above/below level, or failed breakdown
       - option structure type such as debit spread, call spread, put spread, calendar, or defined-risk long premium
       - intended hold time of 2-3 weeks
       - invalidation level and risk notes
       - source URLs and concise observed evidence
    5. Submit all items with Synthesis MCP `synthesis_submit_batch`.
    6. Write `/workspace/.agentrun/synthesis-deep-alpha/report.md` containing run id, submitted item titles, dedupe keys, sources used, and any data gaps.

    Strict Synthesis item schema:
    - `title`: max 180 characters.
    - `synthesis`: concise human synthesis, max 3000 characters.
    - `takeaways`: 3 to 6 bullets, each max 220 characters.
    - `whyValuable`: why this is worth tracking now, max 1200 characters.
    - `sourcePosts`: at least one object with `originalUrl` and `observedText`; use source URLs even when the source is not X.
    - `factChecks`: use statuses `verified`, `unclear`, `refuted`, or `rumor`.
    - `dedupeKey`: use the format `deep-alpha-options:2026052612:nvda`, replacing the timestamp and ticker/theme for the current run.
    - `topicTags`: include `deep-alpha`, `options`, `technical-analysis`, `2-3-week-hold`, and lowercase ticker/theme tags.
    - `score`: 0 to 1, based on evidence quality, setup clarity, liquidity, and immediacy.
    - `confidence`: 0 to 1, reduced for unverifiable option-chain data or mixed technicals.

    Submission quality bar:
    - Do not submit generic market commentary.
    - Do not submit an item without at least two independent sources unless the confidence is no higher than 0.45 and the missing evidence is stated.
    - Do not submit naked high-risk options as the preferred structure; prefer defined-risk strategies.
    - Do not finish until `synthesis_submit_batch` returns success.
```

- [ ] **Step 3: Render and inspect prompt placement**

Run:

```bash
kustomize build argocd/applications/synthesis >/tmp/synthesis-render.yaml
rg -n "kind: ImplementationSpec|synthesis-deep-alpha-options-v1|synthesis_submit_batch|parameters.prompt" /tmp/synthesis-render.yaml
```

Expected: `ImplementationSpec`, `synthesis-deep-alpha-options-v1`, and `synthesis_submit_batch` are present; `parameters.prompt` is absent.

- [ ] **Step 4: Commit**

```bash
git add argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agent.yaml \
  argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-implspec.yaml
git commit -m "feat(synthesis): add deep alpha research agent"
```

## Task 4: Add AgentRun Template And Every-3-Hour Schedule

**Files:**
- Create: `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agentrun-template.yaml`
- Create: `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-schedule.yaml`

- [ ] **Step 1: Create the reusable AgentRun template**

Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agentrun-template.yaml`:

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: synthesis-deep-alpha-template
  annotations:
    agents.proompteng.ai/template: "true"
spec:
  agentRef:
    name: synthesis-deep-alpha-agent
  implementationSpecRef:
    name: synthesis-deep-alpha-options-v1
  goal:
    objective: Research and post Synthesis deep-alpha 2-3 week options strategy candidates with technical entry timing.
  runtime:
    type: job
    config:
      serviceAccountName: agents-sa
      backoffLimit: 0
      logRetentionSeconds: 604800
  ttlSecondsAfterFinished: 21600
  parameters:
    cadence: three-hours
    destination: synthesis
    holdingPeriod: two-to-three-weeks
    strategyScope: defined-risk-options
  secrets:
    - synthesis-env
  workload:
    resources:
      requests:
        cpu: "1"
        memory: 2Gi
        ephemeral-storage: 4Gi
      limits:
        memory: 8Gi
        ephemeral-storage: 8Gi
```

- [ ] **Step 2: Create the every-3-hour Schedule**

Create `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-schedule.yaml`:

```yaml
apiVersion: schedules.proompteng.ai/v1alpha1
kind: Schedule
metadata:
  name: synthesis-deep-alpha-every-3h
  labels:
    app.kubernetes.io/part-of: synthesis
    app.kubernetes.io/component: deep-alpha-agentrun
spec:
  cron: "0 */3 * * *"
  timezone: America/Los_Angeles
  targetRef:
    apiVersion: agents.proompteng.ai/v1alpha1
    kind: AgentRun
    name: synthesis-deep-alpha-template
```

- [ ] **Step 3: Verify the template will not run immediately**

Run:

```bash
kustomize build argocd/applications/synthesis >/tmp/synthesis-render.yaml
rg -n "agents.proompteng.ai/template: \"true\"|kind: Schedule|0 \\*/3 \\* \\* \\*" /tmp/synthesis-render.yaml
```

Expected: the template annotation and schedule cron are present. The template annotation makes the controller set `status.phase=Template` and skip direct job submission.

- [ ] **Step 4: Commit**

```bash
git add argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-agentrun-template.yaml \
  argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-schedule.yaml
git commit -m "feat(synthesis): schedule deep alpha agentrun"
```

## Task 5: Local Validation

**Files:**
- Validate: `argocd/applications/synthesis/**`

- [ ] **Step 1: Render the app**

Run:

```bash
kustomize build argocd/applications/synthesis >/tmp/synthesis-render.yaml
```

Expected: exits `0`.

- [ ] **Step 2: Run repo Kubernetes validation**

Run:

```bash
bun run lint:argocd
```

Expected: exits `0`.

- [ ] **Step 3: Confirm the prompt is not placed in parameters**

Run:

```bash
rg -n "parameters\\.prompt|workflow:.*prompt|spec\\.parameters\\.prompt" argocd/applications/synthesis/agents-domain /tmp/synthesis-render.yaml
```

Expected: no output and exit code `1`.

- [ ] **Step 4: Confirm no broker/order secret is referenced**

Run:

```bash
rg -n "alpaca|broker|order|ALPACA|TRADING_" argocd/applications/synthesis/agents-domain
```

Expected: matches only prompt safety language such as "order-entry" or "Do not place trades"; no secret names, env vars, or MCP server entries for broker credentials.

- [ ] **Step 5: Server-side dry-run against the live cluster**

Run:

```bash
kubectl apply --server-side --dry-run=server -f /tmp/synthesis-render.yaml
```

Expected: exits `0`. If the command fails on immutable generated fields from unrelated Synthesis resources, re-run a narrower dry-run against the new agents-domain output:

```bash
kustomize build argocd/applications/synthesis/agents-domain >/tmp/synthesis-agents-domain-render.yaml
kubectl apply --server-side --dry-run=server -f /tmp/synthesis-agents-domain-render.yaml
```

Expected: exits `0`.

## Task 6: Pull Request And CI

**Files:**
- Use: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Create the branch from fresh main before final implementation**

Run before executing file edits in a production branch:

```bash
git fetch origin main
git switch -c codex/synthesis-deep-alpha-agentrun origin/main
```

Expected: branch `codex/synthesis-deep-alpha-agentrun` exists and is based on current `origin/main`.

- [ ] **Step 2: Push commits**

Run:

```bash
git push -u origin codex/synthesis-deep-alpha-agentrun
```

Expected: branch is pushed.

- [ ] **Step 3: Create PR body from template**

Run:

```bash
cp .github/PULL_REQUEST_TEMPLATE.md /tmp/synthesis-deep-alpha-agentrun-pr.md
```

Fill `/tmp/synthesis-deep-alpha-agentrun-pr.md` with:

```markdown
## Summary

- Adds Synthesis-owned Agents CRDs under `argocd/applications/synthesis/agents-domain`.
- Reflects `synthesis-env` into `agents` so the scheduled runner can authenticate to Synthesis MCP.
- Adds a reusable AgentRun template and Schedule that runs every 3 hours and posts strict Synthesis deep-alpha options research items.

## Testing

- `kustomize build argocd/applications/synthesis`
- `bun run lint:argocd`
- `kubectl apply --server-side --dry-run=server -f /tmp/synthesis-agents-domain-render.yaml`

## Rollout / Risk

- Argo CD auto-syncs the Synthesis app.
- The AgentRun template is annotated as a template, so only the Schedule-created clone runs.
- No broker or trading secrets are referenced; the prompt forbids order placement.
- Emergency brake: patch `cronjob/synthesis-deep-alpha-every-3h-cron` with `{"spec":{"suspend":true}}`, then revert or remove the Schedule through GitOps.
```

- [ ] **Step 4: Scan PR body for scaffolding text**

Run:

```bash
rg -n 'TO''DO|TB''D|\[ \]' /tmp/synthesis-deep-alpha-agentrun-pr.md
```

Expected: no output and exit code `1`.

- [ ] **Step 5: Open the PR**

Run:

```bash
gh pr create \
  --title "feat(synthesis): schedule deep alpha agentrun" \
  --body-file /tmp/synthesis-deep-alpha-agentrun-pr.md
```

Expected: PR opens with conventional title and filled body.

- [ ] **Step 6: Wait for checks**

Run:

```bash
gh pr checks --watch
```

Expected: all required checks pass.

## Task 7: GitOps Rollout Verification

**Files:**
- Verify live cluster state only.

- [ ] **Step 1: Merge after green checks**

Run:

```bash
gh pr merge --squash
```

Expected: PR merges through squash merge.

- [ ] **Step 2: Wait for Synthesis Argo sync**

Run:

```bash
argocd app wait synthesis --health --sync --timeout 600
argocd app get synthesis
```

Expected: Synthesis app is `Synced` and `Healthy`.

- [ ] **Step 3: Verify reflected secret**

Run:

```bash
kubectl -n agents get secret synthesis-env -o jsonpath='{.metadata.name}{"\n"}'
```

Expected:

```text
synthesis-env
```

- [ ] **Step 4: Verify Agent primitives**

Run:

```bash
kubectl -n agents get agentprovider synthesis-deep-alpha
kubectl -n agents get agent synthesis-deep-alpha-agent
kubectl -n agents get implementationspec synthesis-deep-alpha-options-v1
kubectl -n agents get agentrun synthesis-deep-alpha-template -o jsonpath='{.status.phase}{"\n"}'
kubectl -n agents get schedule synthesis-deep-alpha-every-3h -o jsonpath='{.status.phase}{"\n"}'
kubectl -n agents get cronjob synthesis-deep-alpha-every-3h-cron
```

Expected:

```text
Template
Active
```

The CronJob command should exist as `bun run /app/services/agents/src/server/supporting-schedule-runner.ts`.

- [ ] **Step 5: Inspect the controller-generated schedule template**

Run:

```bash
kubectl -n agents get cm synthesis-deep-alpha-every-3h-template -o jsonpath='{.data.run\.json}' | jq '.metadata.generateName, .spec.implementationSpecRef, .spec.parameters'
```

Expected: generateName starts with `synthesis-deep-alpha-every-3h-`, implementation spec is `synthesis-deep-alpha-options-v1`, and parameters do not include `prompt`.

## Task 8: Manual End-To-End Smoke

**Files:**
- Verify live cluster state and Synthesis output.

- [ ] **Step 1: Trigger the schedule runner once**

Run:

```bash
SMOKE_JOB="synthesis-deep-alpha-smoke-$(date -u +%Y%m%d%H%M%S)"
kubectl -n agents create job "$SMOKE_JOB" --from=cronjob/synthesis-deep-alpha-every-3h-cron
```

Expected: a one-off Kubernetes Job is created. This job runs the schedule runner, which creates a generated AgentRun from the template.

- [ ] **Step 2: Find the generated AgentRun**

Run:

```bash
RUN="$(kubectl -n agents get agentrun \
  -l schedules.proompteng.ai/schedule=synthesis-deep-alpha-every-3h \
  -o json | jq -r '.items | sort_by(.metadata.creationTimestamp) | last.metadata.name')"
echo "$RUN"
```

Expected: output starts with `synthesis-deep-alpha-every-3h-`.

- [ ] **Step 3: Follow the runner job logs**

Run:

```bash
AGENT_JOB="$(kubectl -n agents get job \
  -l agents.proompteng.ai/agent-run="$RUN" \
  -o jsonpath='{.items[0].metadata.name}')"
kubectl -n agents logs -f "job/$AGENT_JOB"
```

Expected: logs show Codex started, Synthesis MCP tools are available, `synthesis_start_run` succeeded, and `synthesis_submit_batch` succeeded.

- [ ] **Step 4: Wait for AgentRun success**

Run:

```bash
kubectl -n agents wait --for=jsonpath='{.status.phase}'=Succeeded "agentrun/$RUN" --timeout=45m
kubectl -n agents get agentrun "$RUN" -o jsonpath='{.status.phase}{" "}{.status.conditions[?(@.type=="Succeeded")].reason}{"\n"}'
```

Expected:

```text
Succeeded Completed
```

- [ ] **Step 5: Verify Synthesis received items**

Run from a network context that can reach the tailnet Synthesis URL:

```bash
curl -sS 'http://synthesis.ide-newton.ts.net/api/feed?limit=10&tag=deep-alpha' \
  | jq -r '.items[] | [.title, (.topicTags | join(",")), .dedupeKey] | @tsv'
```

Expected: at least three fresh items include `deep-alpha`, `options`, and `technical-analysis` tags, with dedupe keys beginning `deep-alpha-options:`.

- [ ] **Step 6: Verify report artifact exists**

Run:

```bash
kubectl -n agents get agentrun "$RUN" -o json | jq '.status.artifacts'
```

Expected: artifact list includes `synthesis-deep-alpha-report`, `runner-log`, and `runner-status`.

## Task 9: Rollback And Brake Procedure

**Files:**
- Modify only if rollback is needed: `argocd/applications/synthesis/kustomization.yaml`
- Modify only if rollback is needed: `argocd/applications/synthesis/agents-domain/synthesis-deep-alpha-schedule.yaml`

- [ ] **Step 1: Emergency brake if a run is producing bad output**

Run:

```bash
kubectl -n agents patch cronjob synthesis-deep-alpha-every-3h-cron --type merge -p '{"spec":{"suspend":true}}'
```

Expected: new scheduled executions stop immediately. Document this direct cluster patch in the incident or rollout notes because GitOps may reconcile it.

- [ ] **Step 2: GitOps rollback**

Run:

```bash
git fetch origin main
git switch -c codex/revert-synthesis-deep-alpha-agentrun origin/main
MERGE_COMMIT_SHA="$(git log --format='%H %s' -n 50 | rg 'feat\\(synthesis\\): schedule deep alpha agentrun' | awk '{print $1; exit}')"
test -n "$MERGE_COMMIT_SHA"
git revert "$MERGE_COMMIT_SHA"
git push origin HEAD
```

Open and merge the revert PR using the normal PR template.

Expected: Argo removes the Schedule and no new generated AgentRuns are created.

- [ ] **Step 3: Confirm no future schedule remains**

Run:

```bash
kubectl -n agents get schedule synthesis-deep-alpha-every-3h
kubectl -n agents get cronjob synthesis-deep-alpha-every-3h-cron
```

Expected after rollback: both commands return `NotFound`.

## Self-Review

- Spec coverage: The plan adds Synthesis-owned GitOps resources, runs every 3 hours, posts to Synthesis MCP, requires short-term 2-3 week options strategy content, includes technical-analysis entry timing, and covers rollout plus smoke verification.
- Prompt precedence: The task prompt lives in `ImplementationSpec.spec.text`; the AgentRun template has no `spec.parameters.prompt`.
- Secret model: The Synthesis API token remains in `synthesis-env`; reflector mirrors it to `agents` for the scheduled runner.
- Safety: The plan does not add broker credentials or order-entry MCP tools.
- Rollout: The plan includes local render validation, Argo sync, CRD status checks, manual schedule trigger, Synthesis feed verification, artifact verification, and rollback.
