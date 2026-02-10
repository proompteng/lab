# AgentRuns Handoff (Torghut Trading System)

## Status
- Version: `v1`
- Last updated: **2026-02-08**
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
1) Confirm whether trading must be paused:
   - If TA freshness is uncertain, set `TRADING_ENABLED=false` in `argocd/applications/torghut/knative-service.yaml` and sync.
2) Check pipeline health:
   - `torghut-ws` readiness (`/readyz`) and logs for `401/403` or `406`.
   - `torghut-ta` FlinkDeployment state and checkpoint health.
   - ClickHouse free disk and replica health.
3) Verify freshness end-to-end:
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
1) open/prepare a PR that edits `argocd/applications/torghut/**`, then
2) let ArgoCD reconcile,
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
    torghut.proompteng.ai/actuation: "true"
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
- Avoid setting `spec.parameters.prompt` unless you intend to override the ImplementationSpec text (prompt precedence is documented in `docs/agents/agentrun-creation-guide.md`).

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
1) Produce a single “Torghut health report” (WS, Flink, ClickHouse, freshness) without manual kubectl.
2) Safely pause trading via GitOps (paper/live gates unchanged).
3) Restart forwarder (single replica) and restart TA job (nonce bump) with audit trails.
4) Execute the TA replay workflow from `argocd/applications/torghut/README.md` with explicit confirmation steps.
