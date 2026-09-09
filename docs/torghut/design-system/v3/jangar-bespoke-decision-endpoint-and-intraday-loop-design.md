# Jangar Bespoke Decision Endpoint and Intraday Loop Design

## Status

- Version: `v1`
- Date: `2026-02-12`
- Maturity: `proposed implementation design`

## Objective

Replace Torghut's current dependency on Jangar's OpenAI-compatible completion endpoint with a dedicated decision-engine
endpoint that:

- launches agent execution with quant-specific skills,
- supports long-running execution and progress streaming,
- returns deterministic decision artifacts for Torghut execution policy,
- runs continuously in an intraday loop driven by refined strategy triggers.

Quant performance control-plane contract:

- `docs/agents/designs/jangar-quant-performance-control-plane.md`

## Current Baseline

### Current call path

- Torghut LLM client calls:
  - `/openai/v1/chat/completions`
  - source: `services/torghut/app/trading/llm/client.py`
- Jangar completion route:
  - `services/jangar/src/routes/openai/v1/chat/completions.ts`
  - backed by `services/jangar/src/server/chat.ts`

### Verified runtime/data facts (2026-02-12 06:31-06:35 UTC)

- Runtime:
  - `ksvc/torghut` ready on `torghut-00062`.
  - `deployment/jangar` healthy (`1/1`).
- Torghut posture:
  - `/trading/status` confirms `mode=paper`, `running=true`, LLM shadow enabled.
- CNPG (`torghut-db`) sample:
  - `trade_decisions_total=2852`, `executions_total=484`, `position_snapshots_total=3932`.
- ClickHouse sample:
  - latest `ta_signals.event_ts=2026-02-11T21:58:42Z` and `ta_microbars.window_end=2026-02-11T21:58:42Z`.
- Jangar control-plane status endpoint reports healthy controllers/adapters.
- Observed blocker:
  - Jangar `/api/torghut/trading/*` routes returned
    `self signed certificate in certificate chain` (Torghut DB trust-chain issue).

### Evidence collection playbook

- `docs/agents/designs/jangar-torghut-live-analysis-playbook.md`

### Why this is insufficient

- Completion endpoint is generic chat transport, not a quant decision contract.
- No explicit lifecycle for long-running decision workflows (accepted/running/final).
- No first-class output schema for:
  - news/fundamental/technical synthesis,
  - risk/exposure/position-sizing rationale,
  - execution adapter hint (`alpaca` vs `lean`) with confidence and bounds.

## Target Decision Interface

### New bespoke endpoint

- `POST /api/torghut/decision-engine/stream`
- Content type: `application/json`
- Response type: `text/event-stream`
- Connection model: server-sent events with heartbeat + progress + final decision envelope.

### Request contract (minimum)

```json
{
  "request_id": "uuid",
  "symbol": "NVDA",
  "strategy_id": "intraday-v3-momentum-01",
  "trigger": {
    "type": "signal_cross",
    "event_ts": "2026-02-12T15:31:02Z",
    "source": "torghut-ta",
    "features": {
      "macd": "1.2",
      "macd_signal": "0.8",
      "rsi14": "61.4",
      "spread_bps": "5.1"
    }
  },
  "portfolio": {
    "equity": "100000",
    "buying_power": "250000",
    "current_exposure": "42000",
    "position": {
      "symbol": "NVDA",
      "qty": "40",
      "market_value": "6400"
    }
  },
  "risk_policy": {
    "max_notional_per_trade": "7000",
    "max_position_pct_equity": "0.08",
    "kill_switch_enabled": false
  },
  "execution_context": {
    "primary_adapter": "alpaca",
    "lean_enabled": true,
    "mode": "paper"
  }
}
```

### SSE event contract (minimum)

- `decision.accepted`
- `decision.progress`
- `decision.context_ready`
- `decision.analysis_complete`
- `decision.final`
- `decision.error`
- heartbeat comments every 5-15s.

Final event payload must include:

- normalized `DecisionIntent`,
- confidence + uncertainty notes,
- bounded size recommendation,
- execution adapter hint + reason,
- artifact references (news/fundamentals/technicals/risk).

## Skill Execution Requirements

Decision run must execute a fixed skill bundle (versioned):

- `market-context`
- `news-sentiment`
- `fundamentals`
- `technicals-regime`
- `risk-exposure-sizing`
- `execution-routing`

Required guarantees:

- each skill emits structured JSON,
- each domain output has freshness + source quality metadata,
- missing/stale domains are explicit risk flags (never silently omitted).

## Long-Running Workflow Options

### Option A: Synchronous blocking HTTP

Flow:

- Torghut calls bespoke endpoint.
- Jangar executes agent inline and holds connection until final result.

Pros:

- simplest request/reply semantics.
  Cons:
- fragile for long runs, retries, and restarts.
- poor operator visibility for partial progress.

Use when:

- maximum decision latency is tightly bounded (<20-30s).

### Option B: Submit + poll run status

Flow:

- Torghut submits request (`202 Accepted`) with `run_id`.
- Torghut polls `/api/torghut/decision-engine/runs/{id}`.

Pros:

- resilient to caller disconnects.
- easy retries/idempotency.
  Cons:
- polling overhead and delayed progress visibility.

Use when:

- clients cannot keep streaming connections open.

### Option C: Submit + SSE stream (recommended baseline)

Flow:

- Torghut posts request to stream endpoint.
- Jangar starts AgentRun/OrchestrationRun and streams status events until final.

Pros:

- rich progress and low-latency completion.
- good fit with existing Jangar SSE patterns (`/api/agents/events`).
  Cons:
- needs robust heartbeat/timeout handling on both sides.

Use when:

- intraday decisions may take 20s-5m and observability is required.

### Option D: Temporal workflow orchestration + SSE bridge (recommended for long/complex runs)

Flow:

- endpoint starts Temporal workflow (`decision-workflow`).
- workflow fan-outs skill tasks, waits for completion, aggregates decision.
- SSE route streams workflow state and final decision.

Pros:

- strongest durability/retry semantics.
- explicit timeout, compensation, and recovery behavior.
  Cons:
- highest implementation complexity.

Use when:

- decision workflow includes external providers and variable latency.

## Recommendation

- Phase 1: Option C (SSE + AgentRun/OrchestrationRun) for fast delivery.
- Phase 2: Option D (Temporal) for hardened long-running durability.

## Execution Path and LEAN Integration

### Decision-output boundary

Bespoke endpoint returns intent, never raw broker order submission:

- Torghut remains authority for deterministic policy checks and order firewall.
- Decision output includes:
  - `action`, `qty`, `order_constraints`,
  - `max_slippage_bps`,
  - `adapter_hint` (`alpaca` | `lean`),
  - rationale and risk flags.

### Adapter routing

- Torghut execution policy resolves final adapter using:
  - risk state,
  - policy gates,
  - adapter health,
  - decision `adapter_hint`.
- LEAN route allowed only when:
  - `TRADING_EXECUTION_ADAPTER_POLICY` allows it,
  - paper/canary gates pass,
  - fallback to Alpaca is available.

## Intraday Trigger-Loop Options

### Loop Option 1: Torghut scheduler-driven (recommended start)

- Existing `TradingScheduler` in Torghut continues to trigger cycles.
- Each strategy trigger calls bespoke endpoint once per candidate decision.

Pros:

- minimal architectural disruption.
- reuse existing kill-switch and cadence controls.

### Loop Option 2: Jangar Schedule primitive driven

- Use `Schedule` CRD targeting `OrchestrationRun`/`AgentRun`.
- Jangar cron launches recurring decision runs.

Pros:

- native control-plane ownership of loop cadence.
  Cons:
- weaker direct coupling to real-time torghut-ta trigger events.

### Loop Option 3: Event-driven from torghut-ta signal stream

- signal events trigger orchestration run creation directly.

Pros:

- lowest trigger latency.
  Cons:
- requires dedupe/idempotency controls for bursty events.

### Recommended operating model

- Hybrid:
  - short term: Loop Option 1 (Torghut scheduler-driven),
  - medium term: add event-trigger path for high-priority setups,
  - keep Schedule CRD for fallback cadence and recovery mode.

## Proposed Implementation Plan

### Workstream 0: Connectivity/trust prerequisites

Owned areas:

- `argocd/applications/jangar/deployment.yaml`
- `services/jangar/src/server/torghut-trading-db.ts`

Deliverables:

- fix `TORGHUT_DB_DSN` TLS trust-chain in Jangar runtime,
- ensure Torghut trading reads from Jangar are reliable before bespoke endpoint rollout,
- add endpoint preflight probe in rollout checklist.

### Workstream A: Bespoke endpoint API

Owned areas:

- `services/jangar/src/routes/api/torghut/decision-engine/stream.ts` (new)
- `services/jangar/src/routes/api/torghut/decision-engine/runs/$id.ts` (new, if poll fallback kept)
- `services/jangar/src/server/torghut-decision-engine.ts` (new)
- `services/jangar/src/server/agent-messages-store.ts` (reuse for progress events)

Deliverables:

- request validation schema,
- SSE stream with heartbeats and lifecycle events,
- idempotency by `request_id`,
- persisted run state.

### Workstream B: Agent workflow wiring

Owned areas:

- `argocd/applications/jangar/jangar-primitives-agent*.yaml`
- `argocd/applications/jangar/jangar-primitives-orchestration*.yaml`
- `skills/*` (new quant decision skills)

Deliverables:

- dedicated `decision-engine` agent/orchestration templates,
- skill bundle execution contract,
- status events to `/api/agents/events`.

### Workstream C: Torghut client migration

Owned areas:

- `services/torghut/app/config.py`
- `services/torghut/app/trading/llm/client.py` (or new decision client module)
- `services/torghut/app/trading/scheduler.py`

Deliverables:

- feature-flagged client path to bespoke endpoint,
- long-connection timeout/retry policy,
- fallback behavior to current path for staged rollout.

### Workstream D: Temporal hardening (phase 2)

Owned areas:

- Jangar Temporal integration points (`services/jangar/src/server/**`)
- workflow definitions for `decision-workflow` (new)

Deliverables:

- temporal workflow start/wait/cancel semantics,
- durable retries and timeout envelopes,
- SSE bridge from workflow state to caller.

## Guardrails and Failure Handling

- Hard timeout per decision run with explicit `decision.error`.
- Caller disconnect must not lose run state.
- Duplicate triggers (`request_id`) must return existing run.
- If context quality below threshold:
  - emit decision with veto/hold recommendation,
  - never auto-escalate risk budget.

## Verification

```bash
kubectl -n jangar get deploy jangar
kubectl -n torghut get ksvc torghut
kubectl -n agents get agentrun,orchestrationrun
kubectl -n agents logs deploy/agents-controllers --tail=200
kubectl -n jangar logs deploy/jangar --tail=200
```

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v3-bespoke-decision-endpoint-impl-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `jangarNamespace`
  - `torghutNamespace`
  - `agentsNamespace`
  - `designDoc`
  - `gitopsPath`
- Expected artifacts:
  - bespoke endpoint route + service layer,
  - decision workflow templates,
  - torghut client integration changes,
  - integration tests for timeout/disconnect/idempotency.
- Exit criteria:
  - Torghut can complete decision cycle via bespoke endpoint in paper mode,
  - long-running (>60s) runs stream progress and finish correctly,
  - fallback and rollback paths validated.
