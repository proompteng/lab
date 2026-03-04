# AgentRuns Handoff (Torghut Trading System)

## Status

- Version: `v1`
- Last updated: **2026-02-11**
- Source of truth (config): `argocd/applications/torghut/**`
- Intended audience: AgentRuns implementers and oncall automation engineers

## Purpose

Provide a production-quality handoff pack so the AgentRuns platform (and any automation built on it) can safely:

- operate Torghut day-2 (diagnosis, recovery, rotation),
- implement incremental improvements without violating trading safety invariants,
- and automate routine operational procedures as controlled AgentRuns in Kubernetes.

## Non-negotiable safety invariants

- **Paper trading is the default**. Live trading requires explicit enablement and audited change control.
- **AI is advisory** and must not bypass deterministic risk gates.
- **Single Alpaca market-data WS connection per account** (Alpaca returns `406` for a second connection): forwarder must remain single-active.

## What Torghut is (one paragraph)

Torghut ingests Alpaca market data via a Kotlin WebSocket forwarder (`torghut-ws`) into Kafka, computes technical-analysis
signals in a Flink job (`torghut-ta`), stores outputs in ClickHouse (authoritative for both UI and trading inputs), and
optionally runs a Knative trading service (`torghut`) that makes deterministic strategy decisions, applies deterministic
risk gates, and then submits paper/live orders to Alpaca (live gated).

## Architecture quick view

See `docs/torghut/design-system/v1/overview.md` and `docs/torghut/design-system/v1/architecture-and-context.md`.

## Repo map (where things live)

- GitOps manifests: `argocd/applications/torghut/**`
- WS forwarder (Kotlin): `services/dorvud/websockets/`
- Flink TA job (Kotlin): `services/dorvud/technical-analysis-flink/`
- Trading service (Python/FastAPI): `services/torghut/`
- Jangar (symbols + TA visuals API): `services/jangar/src/routes/api/torghut/**`
- Canonical design docs index: `docs/torghut/design-system/README.md`

## Production entrypoints (what to look at first)

- ArgoCD app resources + TA replay procedure: `argocd/applications/torghut/README.md`
- Current state + prioritized gaps: `docs/torghut/design-system/v1/current-state-and-gap-analysis-2026-02-08.md`
- Operations:
  - TA replay/recovery: `docs/torghut/design-system/v1/operations-ta-replay-and-recovery.md`
  - WS connection-limit/auth: `docs/torghut/design-system/v1/operations-ws-connection-limit-and-auth.md`
  - ClickHouse replica/keeper: `docs/torghut/design-system/v1/operations-clickhouse-replica-and-keeper.md`
  - Knative revision failures: `docs/torghut/design-system/v1/operations-knative-revision-failures.md`

## “First 15 minutes” oncall checklist

1. Confirm whether trading must be paused:
   - If TA freshness is uncertain, set `TRADING_ENABLED=false` in `argocd/applications/torghut/knative-service.yaml` and sync.
2. Check pipeline health:
   - `torghut-ws` readiness (`/readyz`) and logs for `401/403` or `406`.
   - `torghut-ta` FlinkDeployment state and checkpoint health.
   - ClickHouse free disk and replica health.
3. Verify freshness end-to-end:
   - Jangar `GET /api/torghut/ta/latest?symbol=...` (staleness/lag signal).

## Automation guidance (how to use AgentRuns safely)

This section describes guardrails for turning Torghut operational procedures into AgentRuns.

### Recommended model

- Prefer **read-only** diagnostics AgentRuns (list/watch/get/logs) and separate, tightly-scoped “actuation” AgentRuns.
- Require an explicit label gate for actuation runs (example: `torghut.proompteng.ai/actuation=true`) and reject runs
  without it (see Agents admission policies in `charts/agents/README.md`).
- Do not allow arbitrary `kubectl exec` in automation unless unavoidable. Prefer patching CRDs via Kubernetes API.

### Minimal Kubernetes RBAC (Torghut automation)

Scope these permissions to the `torghut` namespace unless explicitly required:

- Read-only diagnostics:
  - `get/list/watch` on `pods`, `deployments`, `replicasets`, `configmaps`, `events`
  - `get/list/watch` on `services.serving.knative.dev` (KService)
  - `get/list/watch` on `flinkdeployments.flink.apache.org`
  - `get/list/watch` on `clickhouseinstallations.clickhouse.altinity.com` (if used in cluster)
  - `get/list/watch` on `clusters.postgresql.cnpg.io` (CNPG)
- Controlled actuation (only for “actuation=true” runs):
  - `patch/update` on `flinkdeployments.flink.apache.org` (pause/resume/restart nonce)
  - `patch/update` on `deployments` (restart forwarder; keep replicas at 1)
  - `patch/update` on `services.serving.knative.dev` (toggle env vars via GitOps preferred; direct patch is emergency-only)

### Strongly preferred: GitOps-first actuation

If the AgentRun is “changing state”, prefer it to:

1. open/prepare a PR that edits `argocd/applications/torghut/**`, then
2. let ArgoCD reconcile,
   instead of directly mutating live objects.

See `docs/torghut/design-system/v1/operations-actuation-runner.md` for the **gated** actuation runner details,
supported procedures, and exact patch shapes.

### AgentRuns templates (copy/paste)

These are minimal skeletons. Customize:

- `metadata.namespace` (where your Agents system is installed),
- `spec.agentRef.name` (the agent you run),
- `spec.implementationSpecRef.name` (the ImplementationSpec containing the Torghut procedure),
- runtime type/config (workflow vs job), and
- any required `contract.requiredKeys` on your ImplementationSpec.

Read-only diagnostic AgentRun (recommended default):

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: torghut-diag-health
  namespace: agents
  labels:
    torghut.proompteng.ai/purpose: diagnostics
spec:
  agentRef:
    name: <agent-name>
  implementationSpecRef:
    name: <implementation-spec-name>
  runtime:
    type: workflow
  ttlSecondsAfterFinished: 600
  vcsPolicy:
    required: false
    mode: none
  parameters:
    namespace: torghut
    service: torghut
    wsDeployment: torghut-ws
    flinkDeployment: torghut-ta
    clickhouseService: torghut-clickhouse
    cnpgCluster: torghut-db
```

GitOps actuation AgentRun (opens PR; read-write VCS required, confirmation enforced):

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: torghut-actuation-gitops
  namespace: agents
  labels:
    torghut.proompteng.ai/purpose: actuation
    torghut.proompteng.ai/actuation: 'true'
spec:
  agentRef:
    name: <agent-name>
  implementationSpecRef:
    name: torghut-actuation-runner-v1
  runtime:
    type: workflow
  ttlSecondsAfterFinished: 7200
  vcsRef:
    name: <vcs-provider-name>
  vcsPolicy:
    required: true
    mode: read-write
  parameters:
    repository: proompteng/lab
    base: main
    head: agentruns/torghut-actuation-<yyyymmdd-hhmm>
    torghutNamespace: torghut
    gitopsPath: argocd/applications/torghut
    change: <pause-trading|restart-ws|suspend-ta|resume-ta>
    reason: <short-human-justification>
    confirm: ACTUATE_TORGHUT
```

ImplementationSpec skeletons (so the AgentRuns above are actually runnable once applied):

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: ImplementationSpec
metadata:
  name: torghut-health-report-v1
  namespace: agents
spec:
  contract:
    requiredKeys:
      - namespace
      - wsDeployment
      - flinkDeployment
      - clickhouseService
      - cnpgCluster
  text: |
    Objective: Produce a single Torghut health report (read-only).

    Inputs: namespace, wsDeployment, flinkDeployment, clickhouseService, cnpgCluster.

    Steps:
    1) Collect forwarder status:
       - kubectl -n ${namespace} get deploy/${wsDeployment}
       - kubectl -n ${namespace} get pods -l app=${wsDeployment}
       - kubectl -n ${namespace} logs deploy/${wsDeployment} --tail=200
    2) Collect Flink status:
       - kubectl -n ${namespace} get flinkdeployment/${flinkDeployment} -o yaml
       - kubectl -n ${namespace} logs -l app=torghut-ta --tail=200 (if labels match)
    3) Collect ClickHouse and CNPG status:
       - kubectl -n ${namespace} get svc/${clickhouseService}
       - kubectl -n ${namespace} get cluster.postgresql.cnpg.io/${cnpgCluster}

    Output:
    - A Markdown report with: overall status, key failures classified, and next recommended procedure links.
```

Notes:

- `ttlSecondsAfterFinished` is a top-level `AgentRun.spec` field (see `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`).
- Avoid setting any prompt-overriding fields on the run request body (`spec.parameters.prompt`, `spec.workflow.steps[].parameters.prompt`) for production Torghut automation.
- Avoid setting `spec.workload.image` unless you intentionally pin a specific runner image.
- For design-doc implementation runs, prefer a single workflow step `implement`; add `plan` only when a separate planning phase is required.
- Keep `AgentRun.metadata.name` <= 63 characters to avoid controller reconciliation failures on propagated label values.
- Do not assume AgentRun parameters are shell env vars inside the runner; verify values via generated `run.json`/`agent-runner.json` payloads.

### Torghut AgentRun prompt contract (authoritative)

- **System prompt source**: `Agent.spec.defaults.systemPromptRef` is the required source of truth for Torghut production runs. If no ref is set, controller fallback is `Agent.spec.defaults.systemPrompt`.
- **Run-level system prompt overrides are not allowed in operation**: `AgentRun.spec.systemPrompt` and `AgentRun.spec.systemPromptRef` are rejected by controller validation and are not part of allowed usage.
- **Work prompt source**: The runnable “what to do” body is always the resolved `ImplementationSpec.spec.text` for `implementationSpecRef` runs (or `spec.implementation.inline.text` for inline runs).
- **Not allowed operational usage**: `spec.parameters.prompt` and `spec.workflow.steps[].parameters.prompt` are not part of allowed production usage.
- Runtime validation point: `run.json.prompt` must reflect the resolved `ImplementationSpec.spec.text` (or inline text). If it does not, fail the run setup before execution.

### Production verification checklist (Torghut AgentRuns)

Use this checklist before trusting any Torghut automation run in production.

```bash
RUN=torghut-health-report-v1-<run-id>
NS=agents

# 1) Confirm workflow-loop flags are enabled in the controller.
kubectl -n "$NS" get deployment agents-controllers \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' \
  | rg 'JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED|JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_MAX_ITERATIONS'

# 2) Confirm runner image and entrypoint/args on the active worker pod.
JOB=$(kubectl -n "$NS" get jobs -l agents.proompteng.ai/agent-run="$RUN" -o jsonpath='{.items[0].metadata.name}')
POD=$(kubectl -n "$NS" get pod -l job-name="$JOB" -o jsonpath='{.items[0].metadata.name}')

kubectl -n "$NS" get pod "$POD" -o jsonpath='{.spec.containers[0].image}{"\n"}'
kubectl -n "$NS" get pod "$POD" -o jsonpath='{range .spec.containers[0].command[*]}{.}{" "}{end}{"\n"}'
kubectl -n "$NS" get pod "$POD" -o jsonpath='{range .spec.containers[0].args[*]}{.}{" "}{end}{"\n"}'

# 3) Validate the generated run payload is using the expected ImplementationSpec body.
CM=$(kubectl -n "$NS" get cm -l "agents.proompteng.ai/agent-run=$RUN" -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$NS" get cm "$CM" -o jsonpath='{.data.run\.json}' | jq -r '.prompt' | sed -n '1,120p'

# Optional: require a known phrase from the selected ImplementationSpec text.
# rg -n "Torghut health report" (reads the generated payload; this is not a runtime env read-back)

# 4) Verify system prompt hash parity: ConfigMap/configured hash, mounted prompt, and status hash must agree.
EXPECTED=$(kubectl -n "$NS" get cm codex-agent-system-prompt -o jsonpath='{.data.system-prompt\.md}' \
  | sha256sum | awk '{print $1}')
STATUS_HASH=$(kubectl -n "$NS" get agentrun "$RUN" -o jsonpath='{.status.systemPromptHash}')
MOUNTED_HASH=$(kubectl -n "$NS" exec "$POD" -- /bin/bash -lc \
  'sha256sum /workspace/.codex/system-prompt.txt | awk "{print \$1}"')
RUNTIME_EXPECTED_HASH=$(kubectl -n "$NS" exec "$POD" -- /bin/bash -lc \
  'echo "$CODEX_SYSTEM_PROMPT_EXPECTED_HASH"')

kubectl -n "$NS" get pod "$POD" \
  -o jsonpath='{range .spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' \
  | rg 'CODEX_SYSTEM_PROMPT_PATH|CODEX_SYSTEM_PROMPT_EXPECTED_HASH|CODEX_SYSTEM_PROMPT_REQUIRED'

echo "expectedFromConfigMap=$EXPECTED"
echo "statusSystemPromptHash=$STATUS_HASH"
echo "mountedPromptHash=$MOUNTED_HASH"
echo "runtimeExpectedHash=$RUNTIME_EXPECTED_HASH"
```

Pass criteria:

- Loop flags include:
  - `JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED=true`
  - `JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_MAX_ITERATIONS=<configured-limit>`
- Pod shows the expected runner image and the intended command/args for the operation.
- `run.json` prompt renders from the target `ImplementationSpec` body (no run-level prompt override).
- `CODEX_SYSTEM_PROMPT_PATH=/workspace/.codex/system-prompt.txt`
- `CODEX_SYSTEM_PROMPT_REQUIRED=true`
- `CODEX_SYSTEM_PROMPT_EXPECTED_HASH` equals both `mountedPromptHash` and `statusSystemPromptHash`.
- If a named system-prompt ConfigMap is in use, its computed hash equals all three above values.

### Progress updates (post-2026-02-08)

- **2026-02-10:** The read-only Torghut health report procedure was exercised successfully via:
  `AgentRun/torghut-health-report-v1-20260210-2` in namespace `agents`.
- **2026-02-10:** Gated actuation runner documented and templated:
  `docs/torghut/design-system/v1/operations-actuation-runner.md`.

## Build/test/release (for implementers)

Concrete commands live in `docs/torghut/ci-cd.md`. Quick pointers:

- WS forwarder image: `services/dorvud/websockets/Dockerfile`
- TA Flink job image: `services/dorvud/technical-analysis-flink/Dockerfile`
- Trading service image: `services/torghut/Dockerfile`

## Known sharp edges (production-proven)

- ClickHouse PVCs are small enough to fill; disk pressure can break JDBC inserts and fail the TA job.
- `torghut-ws` readiness can sit at `503` while liveness is OK; error classification matters for diagnosis.
- The trading service can crash if `uuid.UUID` values leak into JSON-typed fields without coercion.

## Handoff “definition of done” (what AgentRuns should be able to do)

1. Produce a single “Torghut health report” (WS, Flink, ClickHouse, freshness) without manual kubectl.
2. Safely pause trading via GitOps (paper/live gates unchanged).
3. Restart forwarder (single replica) and restart TA job (nonce bump) with audit trails.
4. Execute the TA replay workflow from `argocd/applications/torghut/README.md` with explicit confirmation steps.
