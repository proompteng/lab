# Swarm Intelligence: Single-CRD 24/7 Autonomous Delivery

Status: Proposed (2026-03-01)

Docs index: [README](../README.md)
Execution runbook: [swarm-end-to-end-runbook](../swarm-end-to-end-runbook.md)

## Objective

Provide one always-on swarm control object that continuously discovers work, implements changes, and delivers to
production with machine-only gates when configured for lights-out mode across any chart installation.

## Decision

V1 CRD catalog for swarm control is one resource: `Swarm`.

V1 represents need backlog, owner profile details, and mission tracking as storage-backed runtime records managed by
the Swarm controller.

Reuse existing primitives for execution and policy:

- `AgentRun`, `Orchestration`, `OrchestrationRun`
- `Schedule`, `Signal`
- `Budget`, `ApprovalPolicy`
- `Memory`

Keep high-churn state in runtime storage:

- Ranked need backlog
- Pheromone/confidence traces
- Temporary planner artifacts

These live in Postgres/memory storage.

## Why One CRD Is Enough

- One durable intent object is enough for 24/7 operation: objectives + cadence + autonomy mode + delivery policy.
- Existing controllers already execute workloads and enforce policy; Swarm should orchestrate, not duplicate.
- CRDs are poor for high-frequency ranking updates; DB storage is safer and cheaper operationally.

## Portability

`Swarm` is mission-generic and platform-generic:

- Works for any domain that can express discovery sources, objectives, execution targets, and policy gates.
- Installs with the chart as a reusable primitive for all tenants/users.
- Profile examples in this document are illustrative defaults, not schema constraints.

## Generic Core, Specific Application

The `Swarm` CRD schema is generic and reusable. Runtime behavior becomes specific through instance configuration.

Initial rollout uses two concrete Swarm instances:

- `jangar-control-plane`: agents continuously discover platform work, build new internal constructs for themselves, and
  expand system capabilities with autonomous delivery gates.
- `torghut-quant`: agents continuously discover market/research/ops work and run autonomous quant LLM trading
  improvements under stricter risk and freeze policies.

Each instance uses the same CRD fields with different domain objectives, cadences, risk thresholds, and deployment
targets.

## Internet-Backed Basis

As of 2026-03-01:

- [Argo CD Automated Sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/) supports automated sync,
  optional prune, and self-heal.
- [Argo Rollouts Analysis](https://argoproj.github.io/argo-rollouts/features/analysis/) supports canary gating with
  automatic abort/pause.
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
  and [auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)
  support no-human merge when checks pass.
- [Kyverno verifyImages](https://kyverno.io/docs/policy-types/cluster-policy/verify-images/overview/) and
  [SLSA requirements](https://slsa.dev/spec/v1.1/requirements) enable enforceable provenance.
- Agent benchmarks such as [SWE-bench](https://arxiv.org/abs/2310.06770) and
  [SWE-agent](https://arxiv.org/abs/2405.15793) show non-trivial failure rates, so autonomous loops require retries,
  rollback, and freeze logic.

## Swarm CRD Contract (v1)

Group/version/kind:

- `swarm.proompteng.ai/v1alpha1`
- `kind: Swarm`

### `spec` (required fields)

- `owner.id`: stable owner identity for accountability and routing.
- `owner.channel`: primary conversation channel.
- `domains[]`: mission domains (for example `platform-reliability`, `quant-strategy`, `docs-automation`).
- `objectives[]`: outcome statements (not task lists).
- `mode`: `assisted` or `lights-out`.
- `cadence.discoverEvery`: duration, default `5m`.
- `cadence.planEvery`: duration, default `10m`.
- `cadence.implementEvery`: duration, default `10m`.
- `cadence.verifyEvery`: duration, default `5m`.
- `discovery.sources[]`: source refs (internet + internal signals).
- `discovery.minCitations`: integer, default `2`.
- `discovery.minConfidence`: float, default `0.75`.
- `delivery.repoAllowlist[]`: allowed repos for autonomous changes.
- `delivery.requiredChecks[]`: CI checks that must pass.
- `delivery.mergePolicy`: `auto-merge` or `merge-queue`.
- `delivery.deploymentTargets[]`: deployment identifiers (for GitOps installs, these are Argo CD application names).
- `delivery.rollout.strategy`: `canary`.
- `delivery.rollout.steps[]`: percent + pause (for example `10/30/100`).
- `delivery.rollout.analysisTemplateRef`: Argo Rollouts analysis template.
- `risk.budgetRef`: `Budget` object name.
- `risk.approvalPolicyRef`: `ApprovalPolicy` object name.
- `risk.freezeAfterFailures`: integer consecutive mission failures, default `3`.
- `risk.freezeDuration`: duration, default `60m`.

### `status`

- `phase`: `Idle | Discovering | Planning | Implementing | Verifying | Frozen | Degraded`.
- `conditions[]`: Kubernetes-standard condition list.
- `observedGeneration`, `updatedAt`.
- `lastDiscoverAt`, `lastPlanAt`, `lastImplementAt`, `lastVerifyAt`.
- `activeMissions`, `queuedNeeds`.
- `discoveries24h`, `missions24h`, `autonomousSuccessRate24h`.
- `lastProductionChangeRef` (commit SHA / PR / rollout).
- `freeze.reason`, `freeze.until`.

## Swarm Controller Ownership

Swarm controller owns:

- Parsing and validating Swarm policy.
- Running cadence loops.
- Need ranking, selection, and mission dispatch.
- Deciding assisted vs lights-out execution path.
- Freeze/unfreeze state transitions.
- Status and accountability reporting.

Swarm controller does not own:

- `AgentRun` execution semantics (existing controller).
- Orchestration step semantics (existing controller).
- CI provider logic (GitHub/CI systems).
- Cluster rollout internals (Argo CD / Argo Rollouts).

## 24/7 Loop Contract

1. Discover: ingest internet + internal signals continuously.
2. Normalize: deduplicate and score with provenance.
3. Select: choose highest-value need under budget/risk policy.
4. Implement: launch orchestration and code agent runs.
5. Verify: run CI and autonomous fix retries.
6. Deliver: merge and sync via GitOps.
7. Protect: canary analysis decides promote vs rollback.
8. Learn: persist outcomes to memory and adjust ranking weights.

## Assisted vs Lights-Out

Assisted mode:

- R0/R1 auto-execute.
- R2/R3 require explicit approval per `ApprovalPolicy`.

Lights-out mode:

- R0/R1/R2 auto-execute if all gates pass.
- R3 allowed only for allowlisted repos/services and stricter rollout thresholds.
- Any gate failure blocks promotion and triggers remediation mission.

## Machine Gates (No Human in Lights-Out)

Gate 1: Discovery quality

- Minimum citations and confidence.
- Reject uncited or low-confidence external claims.

Gate 2: Code quality

- Required checks pass.
- Deterministic test matrix must be green.

Gate 3: Merge policy

- Protected branch requirements satisfied.
- Merge queue or auto-merge policy satisfied.

Gate 4: Supply chain

- Artifact signature and provenance verification passes.

Gate 5: Progressive rollout

- Canary analysis passes at each step.
- Abort/rollback on threshold violation.

Gate 6: Post-deploy/post-actuation SLO

- If SLO or risk thresholds regress, rollback and freeze mission class.

## Example Mission Profiles (Instance Overlays)

### Profile A: Jangar Control Plane Self-Construction

Default cadence:

- discover: `5m`
- plan: `10m`
- implement: `10m`
- verify: `5m`

Default delivery thresholds:

- Canary error-rate increase must stay < `20%` vs baseline.
- p95 latency increase must stay < `15%` vs baseline.
- Two consecutive failed canary checks trigger rollback.

### Profile B: Torghut Quant LLM Autonomous Trading

Default cadence:

- discover: `1m`
- plan: `5m`
- implement: `15m` for code/policy changes
- verify: `1m` for risk-health checks

Default risk thresholds (lights-out):

- Intraday drawdown breach at `-1.5%` triggers immediate freeze.
- Consecutive policy violations >= `1` triggers freeze.
- Consecutive failed autonomous missions >= `2` triggers freeze.
- Freeze requires explicit resume policy window.

## Torghut Regime-Change Flexibility Contract (Internet-Backed)

As of 2026-03-01, regime adaptability in `torghut-quant` should follow these source-backed constraints:

- Use regime-switching inference for discrete state changes, not a single stationary model
  ([Hamilton 1989](https://EconPapers.repec.org/RePEc:ecm:emetrp:v:57:y:1989:i:2:p:357-84)).
- Treat long-memory signatures and regime shifts as separable hypotheses before allocation decisions
  ([Diebold and Inoue 2001](https://EconPapers.repec.org/RePEc:eee:econom:v:105:y:2001:i:1:p:131-159)).
- Combine explicit changepoint detection with drift adaptation rather than periodic blind retraining
  ([Adams and MacKay 2007](https://arxiv.org/abs/0710.3742),
  [Bifet and Gavaldà 2007](https://doi.org/10.1137/1.9781611972771.42),
  [Lu et al. 2020](https://arxiv.org/abs/2004.05785)).
- Keep autonomous actuation under hard pre-trade and emergency stop controls
  ([17 CFR 240.15c3-5](https://www.law.cornell.edu/cfr/text/17/240.15c3-5),
  [MiFID II Article 17](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A32014L0065),
  [Commission Delegated Regulation (EU) 2017/589](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32017R0589)).
- Validate strategy selection against data-snooping risk before promotion
  ([White 2000](https://EconPapers.repec.org/RePEc:ecm:emetrp:v:68:y:2000:i:5:p:1097-1126)).

### Most recent research update (2025-2026)

As of 2026-03-01, recent evidence that should be reflected in Torghut policy:

- 2026 peer-reviewed volatility regime modeling reinforces explicit state inference in crypto markets:
  [RIBAF 2026, vol. 83](https://www.sciencedirect.com/science/article/abs/pii/S027553192600022X),
  [Discover Analytics 2026](https://link.springer.com/article/10.1007/s44257-025-00046-1).
- 2025 live evaluation benchmarks show static benchmark scores are weak proxies for live trading quality:
  [LiveTradeBench (arXiv:2511.03628)](https://arxiv.org/abs/2511.03628).
- 2025 multi-agent trading preprints support role-specialized agents with explicit risk modules:
  [QuantAgent (arXiv:2509.09995)](https://arxiv.org/abs/2509.09995),
  [TradingGroup (arXiv:2508.17565)](https://arxiv.org/abs/2508.17565).
- 2025-2026 microstructure RL work emphasizes non-stationary LOB environments and scalable MARL training:
  [Non-stationary LOB market making (arXiv:2509.12456)](https://arxiv.org/abs/2509.12456),
  [JaxMARL-HFT (arXiv:2511.02136)](https://arxiv.org/abs/2511.02136).
- 2025 market-structure risk research highlights autonomous collusion risk in RL trading agents:
  [NBER Working Paper 34054](https://www.nber.org/papers/w34054).

Design implications for Torghut:

- Keep regime detector + drift detector as first-class verify gates.
- Maintain portfolio-of-experts routing with regime-conditioned allocation caps.
- Require live/shadow evaluation windows before full-capital promotion.
- Keep collusion/market-impact safeguards as mandatory risk checks in lights-out mode.
- Mark preprint-backed changes as provisional until replicated in internal live tests.

### Torghut runtime contract (no extra CRDs)

Regime state remains in runtime storage (not CRD fields), versioned per delivery cycle:

- `regime.id`: trend / mean-revert / high-vol / stressed-liquidity / uncertain.
- `regime.posterior`: probability vector over regimes.
- `regime.changepointScore`: online changepoint posterior.
- `regime.driftScore`: detector ensemble alarm score.
- `regime.updatedAt`, `regime.minDwellUntil`.

### Detection and transition policy

- Detector ensemble:
  - Markov-switching posterior.
  - Bayesian online changepoint detector.
  - ADWIN-style adaptive window drift alarm.
  - Market microstructure checks (spread, depth, impact, realized volatility percentile).
- Transition hysteresis:
  - Candidate regime requires persistent confirmation windows.
  - Promotion to active regime requires both posterior and changepoint thresholds.
  - Reversion requires sustained evidence, not one-tick reversal.
- Uncertain regime fallback:
  - When detector disagreement is high, force defensive profile and reduce exposure.

### Allocation and implementation policy

- Portfolio-of-experts routing:
  - Each strategy/expert declares supported regimes.
  - Capital weights are regime-conditioned and capped by per-expert risk budgets.
- Capital rollout for new policy in active regime:
  - shadow -> 1% notional -> 5% -> 20% -> full target only after gated verification.
- Automatic de-allocation:
  - Remove weight from experts that underperform regime-specific baselines after costs/slippage.

### Verification and freeze policy

- Verify loop must enforce regime-specific limits:
  - max drawdown by regime
  - exposure and concentration caps
  - slippage/impact bounds
  - order reject/error rate thresholds
- Freeze conditions:
  - breach of hard risk limits
  - repeated failed implementations
  - repeated verify-gate failures during promotion
- Resume policy:
  - freeze window expiry and successful re-qualification in shadow/canary stages.

## Failure Semantics

- CI failure: autonomous retries up to `N=3`, then `Degraded`.
- Rollout failure: immediate rollback + remediation mission.
- Repeated class failure: freeze class for `freezeDuration`.
- Discovery feed outage: continue with degraded confidence; block high-risk missions.
- Budget breach: block mission dispatch and emit condition.

## Validation Plan (Required Before Production)

1. Contract tests: CRD schema + defaulting + validation.
2. Reconcile tests: phase transitions, freeze logic, retry budget handling.
3. Failure injection drills:
   - CI red loop
   - Canary fail
   - Argo sync drift
   - Discovery source outage
4. Shadow mode run for 7 days:
   - Assisted-only recommendations
   - No production writes
   - Compare predicted vs accepted outcomes
5. Limited lights-out canary:
   - One low-risk repo/service per swarm instance
   - Tight rollback thresholds
   - Daily review of mission traces

## Production Rollout Plan (End-to-End, Huly-First)

### Internet-backed Huly baseline (as of 2026-03-02)

Huly should be treated as the mandatory collaboration layer for virtual workers in this system:

- Huly is presented as an all-in-one open-source platform for project management, team planning, chat, and documents.
- Huly product modules include Team Planner, Chat, Documents, and Inbox.
- Huly platform docs list integrations with GitHub, Telegram, email, and calendars.
- Huly roles/permissions support workspace/team/project/issue-level controls.
- Huly publishes API tooling via `@hcengineering/core` and `@hcengineering/api-client`, with example automation in
  `huly-examples/platform-api`.
- Huly provides self-hosting options (Docker Compose and Kubernetes examples).

### Non-negotiable communication policy

1. All swarm-to-owner communication is written to Huly.
2. All swarm-to-swarm communication between `jangar-control-plane` and `torghut-quant` is written to Huly.
3. Every autonomous mission must have a canonical Huly issue/thread before implementation begins.
4. Any mission without a Huly artifact is invalid for promotion to production.

### Huly workspace topology for virtual workers

Current deployment target uses one shared workspace and shared defaults:

- Workspace: `proompteng`
- Tracker board/project: `DefaultProject`
- Tracker URL: `https://huly.proompteng.ai/workbench/proompteng/tracker/tracker%3Aproject%3ADefaultProject/issues`
- Documents teamspace: `PROOMPTENG`
- Chat channel: `general`
- Chat URL: `https://huly.proompteng.ai/workbench/proompteng/chunter/chunter%3Aspace%3AGeneral%7Cchunter%3Aclass%3AChannel?message`

Required Huly objects per mission:

- One issue in `DefaultProject` (system of record for status and ownership).
- One chat thread linked from the issue (real-time coordination).
- One document page in `PROOMPTENG` linked from the issue (design, evidence, rollout notes).
- One inbox entry for owner visibility (approval, override, or notification path).

### Virtual worker access bundle (all agents)

Every agent identity uses a unique human coworker name and belongs to one of two swarm teams:

- Jangar Engineering
- Torghut Traders

Each worker account must have full module access to the Huly suite used here:

- Issues/project tracking
- Chat
- Documents
- Team Planner
- Inbox

Production controls for these identities:

- Short-lived API credentials issued by a central secret manager.
- Rotation every 24h or on compromise signal.
- Separate credential manifests per swarm team:
  - `argocd/applications/agents/huly-api-jangar-sealedsecret.yaml`
  - `argocd/applications/agents/huly-api-torghut-sealedsecret.yaml`
- One token per agent identity stored as `HULY_API_TOKEN_<SWARM_AGENT_IDENTITY>` (or worker id equivalent).
- One expected actor mapping per identity stored as `HULY_EXPECTED_ACTOR_ID_<SWARM_AGENT_IDENTITY>` and validated before mission writes.
- Space/project permission templates applied automatically at creation time.
- Every write includes `swarm`, `stage`, `missionId`, and `deliveryId` metadata for audit.

### Jangar-Torghut communication contract (via Huly only)

Inter-swarm handoff protocol:

1. Source swarm creates a requirement issue in `DefaultProject` labeled with:
   - `from-swarm`, `to-swarm`, `handoff-type`, `priority`, `deadline`, `risk-tier`.
2. Source swarm posts structured payload in issue body:
   - problem statement, required outcome, constraints, evidence links, acceptance tests.
3. Destination swarm posts ACK comment with planned execution window.
4. Destination swarm links its implementation issue and mirrors status back to the requirement issue.
5. Source swarm closes bridge issue only after destination evidence + verification links are attached.

Kubernetes bridge contract used by the swarm controller:

- Torghut publishes a `Signal` with labels:
  - `swarm.proompteng.ai/type=requirement`
  - `swarm.proompteng.ai/from=<source-swarm>`
  - `swarm.proompteng.ai/to=<destination-swarm>`
- `Signal.spec.channel` must reference Huly (`huly://...` or Huly URL).
- Destination swarm consumes those signals and launches `implement` execution runs with requirement context parameters:
  - `swarmRequirementSignal`
  - `swarmRequirementSource`
  - `swarmRequirementTarget`
  - `swarmRequirementChannel`
  - `swarmRequirementPayload`

Handoff types:

- `risk-alert`: Torghut risk/regime state requires platform or policy action in Jangar.
- `infra-change`: Jangar platform change required for Torghut runtime.
- `strategy-change`: Torghut model/policy update requiring control-plane support.
- `incident`: coordinated rollback/freeze/recovery.

### Rollout phases and exit criteria

Phase 0: Controller reliability and schedule integrity

- Goal: continuous schedule creation and run dispatch with stable swarm status.
- Exit:
  - 24h of schedule ticks without schedule controller errors.
  - `discover/plan/implement/verify` each dispatching runs successfully.
  - Freeze/unfreeze behavior deterministic and alert-backed.

Phase 1: Huly foundation and identity bootstrap

- Goal: all virtual workers can read/write required Huly modules.
- Deliverables:
  - workspace/spaces/projects created,
  - service identities and token issuance flow,
  - mission metadata schema and templates.
- Exit:
  - 100% of autonomous runs create/update Huly artifacts.
  - `huly_write_success_rate >= 99.9%` over 24h.

Phase 2: Jangar swarm assisted-to-autonomous progression

- Goal: Jangar control-plane swarm runs full discovery-to-production path with Huly traceability.
- Steps:
  - 7-day assisted run,
  - low-risk lights-out canary in one repo/app,
  - progressive expansion to allowlisted control-plane targets.
- Exit:
  - `mission_success_rate >= 85%` over trailing 7 days,
  - `rollback_recovery_time_p95 < 15m`,
  - zero production changes without linked Huly issue/chat/doc.

Phase 3: Torghut swarm activation with bridge dependency on Jangar

- Goal: Torghut swarm operates autonomously while coordinating infrastructure/risk dependencies through Huly bridge.
- Steps:
  - enable `risk-alert` and `infra-change` handoff types first,
  - enforce regime/risk gate evidence links in Huly documents.
- Exit:
  - `bridge_ack_latency_p95 < 2m`,
  - `cross_swarm_handoff_success_rate >= 95%`,
  - all regime-change incidents have complete Huly timeline and decisions.

Phase 4: Full dual-swarm 24/7 operation

- Goal: both swarms run continuously with production-grade SLOs and auditable communication.
- Exit:
  - 30-day sustained operation,
  - no untracked autonomous write paths,
  - monthly disaster-recovery and freeze-drill pass.

### End-to-end acceptance tests

1. Discovery-to-production test (Jangar):
   - internet signal -> Huly issue/thread/doc -> AgentRun/PR -> CI -> GitOps rollout -> canary -> Huly closure.
2. Regime-change handoff test (Torghut -> Jangar):
   - Torghut detects regime/risk event -> bridge issue -> Jangar ACK -> platform fix rollout -> Torghut verification.
3. Incident rollback test (both swarms):
   - force failed rollout -> freeze -> rollback -> bridge coordination -> controlled resume.
4. Huly outage behavior test:
   - simulated Huly write failure triggers implementation gate block and `Degraded` condition.

### Operational SLOs

- `swarm_schedule_tick_success_rate >= 99.5%` (per stage).
- `huly_artifact_coverage = 100%` for autonomous missions.
- `cross_swarm_ack_latency_p95 < 2m`.
- `autonomous_change_traceability = 100%` (run -> PR -> deploy -> Huly record).
- `freeze_false_positive_rate < 2%` monthly.

## Example Swarm Object (Generic Template)

```yaml
apiVersion: swarm.proompteng.ai/v1alpha1
kind: Swarm
metadata:
  name: swarm-24x7
  namespace: agents
spec:
  owner:
    id: platform-owner
    channel: swarm://owner/platform
  domains:
    - platform-reliability
    - autonomous-strategy
  objectives:
    - continuously improve reliability and operational quality for managed services
    - continuously improve risk-adjusted outcomes under strict policy limits
  mode: lights-out
  cadence:
    discoverEvery: 1m
    planEvery: 5m
    implementEvery: 10m
    verifyEvery: 1m
  discovery:
    minCitations: 2
    minConfidence: 0.75
    sources:
      - name: github-issues
      - name: runtime-alerts
      - name: external-risk-feed
  delivery:
    repoAllowlist:
      - proompteng/lab
    requiredChecks:
      - lint
      - unit-tests
      - type-check
    mergePolicy: merge-queue
    deploymentTargets:
      - core-platform
      - strategy-runtime
    rollout:
      strategy: canary
      steps:
        - setWeight: 10
          pause: 5m
        - setWeight: 30
          pause: 10m
        - setWeight: 100
          pause: 0m
      analysisTemplateRef: default-canary-analysis
  risk:
    budgetRef: default-budget
    approvalPolicyRef: default-approval
    freezeAfterFailures: 3
    freezeDuration: 60m
```

## Initial Instance Manifests (Specific Application)

### Instance 1: Jangar Control Plane

```yaml
apiVersion: swarm.proompteng.ai/v1alpha1
kind: Swarm
metadata:
  name: jangar-control-plane
  namespace: agents
spec:
  owner:
    id: platform-owner
    channel: swarm://owner/platform
  domains:
    - platform-reliability
    - platform-evolution
  objectives:
    - continuously discover and implement control-plane improvements
    - autonomously construct and expand internal platform capabilities
  mode: lights-out
  cadence:
    discoverEvery: 5m
    planEvery: 10m
    implementEvery: 10m
    verifyEvery: 5m
  delivery:
    deploymentTargets:
      - agents
```

### Instance 2: Torghut Quant LLM Autonomous Trading

```yaml
apiVersion: swarm.proompteng.ai/v1alpha1
kind: Swarm
metadata:
  name: torghut-quant
  namespace: agents
spec:
  owner:
    id: trading-owner
    channel: swarm://owner/trading
  domains:
    - quant-research
    - autonomous-trading
  objectives:
    - continuously discover and implement alpha/risk improvements
    - optimize risk-adjusted outcomes under strict drawdown policy
  mode: lights-out
  cadence:
    discoverEvery: 1m
    planEvery: 5m
    implementEvery: 15m
    verifyEvery: 1m
  delivery:
    deploymentTargets:
      - torghut
  risk:
    freezeAfterFailures: 2
```

## Non-Goals

- Replacing existing AgentRun/Orchestration controllers.
- Storing high-frequency ranked backlog state in CRDs.
- Allowing unrestricted autonomous writes across all repos/services on day one.

## Open Questions

- Should lights-out mode require per-domain approval?
- Should freeze recovery be time-based only, or require explicit policy reset token?
- Do we need one Swarm per domain, or one composite Swarm with weighted objectives?

## References

- Huly product overview: [https://huly.io/](https://huly.io/)
- Huly getting started: [https://docs.huly.io/getting-started/](https://docs.huly.io/getting-started/)
- Huly integrations: [https://docs.huly.io/platform/integrations/](https://docs.huly.io/platform/integrations/)
- Huly roles and permissions: [https://docs.huly.io/platform/roles-and-permissions/](https://docs.huly.io/platform/roles-and-permissions/)
- Huly API and tools: [https://docs.huly.io/platform/api-tools/](https://docs.huly.io/platform/api-tools/)
- Huly self-hosting docs: [https://docs.huly.io/self-hosting/](https://docs.huly.io/self-hosting/)
- Huly self-host repository: [https://github.com/hcengineering/huly-selfhost](https://github.com/hcengineering/huly-selfhost)
- Huly platform API examples: [https://github.com/hcengineering/huly-examples/tree/main/platform-api](https://github.com/hcengineering/huly-examples/tree/main/platform-api)
- Argo CD Automated Sync: [https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- Argo Rollouts Canary: [https://argoproj.github.io/argo-rollouts/features/canary/](https://argoproj.github.io/argo-rollouts/features/canary/)
- Argo Rollouts Analysis: [https://argoproj.github.io/argo-rollouts/features/analysis/](https://argoproj.github.io/argo-rollouts/features/analysis/)
- GitHub protected branches: [https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- GitHub auto-merge: [https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)
- Kyverno verifyImages: [https://kyverno.io/docs/policy-types/cluster-policy/verify-images/overview/](https://kyverno.io/docs/policy-types/cluster-policy/verify-images/overview/)
- SLSA requirements: [https://slsa.dev/spec/v1.1/requirements](https://slsa.dev/spec/v1.1/requirements)
- SWE-bench: [https://arxiv.org/abs/2310.06770](https://arxiv.org/abs/2310.06770)
- SWE-agent: [https://arxiv.org/abs/2405.15793](https://arxiv.org/abs/2405.15793)
- Anthropic effective agents: [https://www.anthropic.com/engineering/building-effective-agents](https://www.anthropic.com/engineering/building-effective-agents)
- OpenAI deep research: [https://openai.com/index/introducing-deep-research/](https://openai.com/index/introducing-deep-research/)
- Hamilton (1989), Markov regime switching: [https://EconPapers.repec.org/RePEc:ecm:emetrp:v:57:y:1989:i:2:p:357-84](https://EconPapers.repec.org/RePEc:ecm:emetrp:v:57:y:1989:i:2:p:357-84)
- Adams and MacKay (2007), Bayesian online changepoint detection: [https://arxiv.org/abs/0710.3742](https://arxiv.org/abs/0710.3742)
- Bifet and Gavaldà (2007), ADWIN: [https://doi.org/10.1137/1.9781611972771.42](https://doi.org/10.1137/1.9781611972771.42)
- Gama et al. (2014), concept drift adaptation survey: [https://doi.org/10.1145/2523813](https://doi.org/10.1145/2523813)
- Lu et al. (2020), learning under concept drift review: [https://arxiv.org/abs/2004.05785](https://arxiv.org/abs/2004.05785)
- Diebold and Inoue (2001), long memory vs regime switching: [https://EconPapers.repec.org/RePEc:eee:econom:v:105:y:2001:i:1:p:131-159](https://EconPapers.repec.org/RePEc:eee:econom:v:105:y:2001:i:1:p:131-159)
- White (2000), reality check for data snooping: [https://EconPapers.repec.org/RePEc:ecm:emetrp:v:68:y:2000:i:5:p:1097-1126](https://EconPapers.repec.org/RePEc:ecm:emetrp:v:68:y:2000:i:5:p:1097-1126)
- SEC market-access risk controls (17 CFR 240.15c3-5): [https://www.law.cornell.edu/cfr/text/17/240.15c3-5](https://www.law.cornell.edu/cfr/text/17/240.15c3-5)
- MiFID II Article 17 algorithmic trading: [https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A32014L0065](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A32014L0065)
- Commission Delegated Regulation (EU) 2017/589 (RTS 6): [https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32017R0589](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32017R0589)
- NIST AI Risk Management Framework: [https://www.nist.gov/itl/ai-risk-management-framework](https://www.nist.gov/itl/ai-risk-management-framework)
- RIBAF 2026 Bitcoin regime-switching volatility: [https://www.sciencedirect.com/science/article/abs/pii/S027553192600022X](https://www.sciencedirect.com/science/article/abs/pii/S027553192600022X)
- Discover Analytics 2026 hybrid Heston-LSTM + blockchain: [https://link.springer.com/article/10.1007/s44257-025-00046-1](https://link.springer.com/article/10.1007/s44257-025-00046-1)
- LiveTradeBench (arXiv:2511.03628): [https://arxiv.org/abs/2511.03628](https://arxiv.org/abs/2511.03628)
- QuantAgent (arXiv:2509.09995): [https://arxiv.org/abs/2509.09995](https://arxiv.org/abs/2509.09995)
- TradingGroup (arXiv:2508.17565): [https://arxiv.org/abs/2508.17565](https://arxiv.org/abs/2508.17565)
- Non-stationary LOB RL market making (arXiv:2509.12456): [https://arxiv.org/abs/2509.12456](https://arxiv.org/abs/2509.12456)
- JaxMARL-HFT (arXiv:2511.02136): [https://arxiv.org/abs/2511.02136](https://arxiv.org/abs/2511.02136)
- NBER w34054 (AI trading and collusion): [https://www.nber.org/papers/w34054](https://www.nber.org/papers/w34054)

## Diagram

```mermaid
flowchart LR
  A["Swarm CRD (Jangar)"] --> B["Swarm Controller (Jangar)"]
  A2["Swarm CRD (Torghut)"] --> B2["Swarm Controller (Torghut)"]
  B --> C["Discovery/Plan/Implement/Verify"]
  B2 --> C2["Discovery/Plan/Implement/Verify"]
  C --> E["AgentRun + OrchestrationRun"]
  C2 --> E2["AgentRun + OrchestrationRun"]
  E --> F["CI + Merge Gates"]
  E2 --> F2["CI + Risk Gates"]
  F --> G["GitOps Sync + Rollout Analysis"]
  F2 --> G2["Trading Policy + Runtime Verification"]
  B --> H["Huly: Issues + Chat + Docs + Inbox"]
  B2 --> H
  H --> I["Swarm Bridge Handoffs"]
  I --> B
  I --> B2
  G --> J["Metrics + Memory Feedback"]
  G2 --> J
```
