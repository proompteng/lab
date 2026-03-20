# 53. Torghut Cross-Plane Profit-Certificate Veto and Options-Auth Isolation (2026-03-20)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Related mission: `codex/swarm-jangar-control-plane-discover`
Companion doc:

- `docs/agents/designs/54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`

Extends:

- `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
- `51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
- `52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`

## Executive summary

The March 20 live state shows that Torghut still has a profit-authority gap. The service can present itself as
promotion-ready while its profit evidence, cross-plane dependencies, and options lane are plainly not ready.

Read-only evidence captured on `2026-03-20` shows:

- `curl -fsS 'http://torghut.torghut.svc.cluster.local/readyz'`
  - `live_submission_gate.ok = true`
  - `live_submission_gate.capital_stage = "0.10x canary"`
  - `alpha_readiness.promotion_eligible_total = 0`
- `curl -fsS 'http://torghut.torghut.svc.cluster.local/trading/status'`
  - `live_submission_gate.allowed = true`
  - `live_submission_gate.reason = "ready"`
  - `shadow_first.capital_stage = "shadow"`
  - `shadow_first.critical_toggle_parity.status = "diverged"`
  - `shadow_first.critical_toggle_parity.mismatches = ["TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION"]`
  - `live_submission_gate.promotion_eligible_total = 0`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=paper&window=15m'`
  - `status = "degraded"`
  - `latestMetricsCount = 0`
  - `emptyLatestStoreAlarm = true`
  - `stages = []`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA'`
  - `overallState = "down"`
  - `bundleFreshnessSeconds = 320583`
  - `domainHealth.technicals.state = "error"`
  - `domainHealth.regime.state = "error"`
  - fundamentals and news are stale
  - ClickHouse ingestion health reports `lastError = "clickhouse_query_failed"`
- `kubectl -n torghut logs pod/torghut-options-catalog-...` and `.../torghut-options-enricher-...`
  - both fail at import/startup with `FATAL: password authentication failed for user "torghut_app"`
- `kubectl -n torghut get events --sort-by=.metadata.creationTimestamp | tail`
  - `torghut-options-ta` is in `ImagePullBackOff`
  - options services are in restart backoff and readiness failure loops
- `curl -fsS 'http://torghut.torghut.svc.cluster.local/db-check'`
  - `schema_current = true`
  - lineage warnings remain for migration parent forks

The selected architecture is to make non-observe capital depend on a **Cross-Plane Profit Certificate** that can be
vetoed by missing or contradictory evidence, plus explicit **options-auth isolation** so options bootstrap failures do
not masquerade as generic service readiness.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarmName: `jangar-control-plane`
- swarmStage: `discover`
- objective: improve Jangar resilience and Torghut profitability with merged architecture outputs

This architecture artifact succeeds when:

1. the current cluster, source, and database evidence is captured with concrete proof;
2. at least two viable directions are compared and one is chosen with explicit tradeoffs;
3. live-capital authorization becomes impossible when promotion evidence is missing, contradictory, or stale;
4. options-lane authentication/bootstrap failures are isolated as typed dependency segments instead of crashing the lane
   before policy can react.

## Assessment snapshot

### Cluster health and live-profit evidence

The live runtime still exposes contradictory profit truth:

- `/readyz` and `/trading/status` can both imply non-shadow capital progress;
- the same response family shows `promotion_eligible_total = 0`, no live orders, and divergent toggle state;
- Jangar quant health reports no latest-store evidence;
- Jangar market-context health reports `overallState = down`;
- options services are not healthy enough to contribute trustworthy evidence;
- the database schema is current, but schema currency alone is not sufficient for profitable promotion.

Interpretation:

- Torghut is over-trusting local gate logic and under-trusting cross-plane evidence;
- readiness and promotion authority are not sufficiently separated;
- options-lane failures are still entering through import-time side effects instead of typed status.

### Source architecture and high-risk modules

Current-branch seams explain the observed contradictions:

- `services/torghut/app/main.py`
  - `_build_live_submission_gate_payload(...)` only blocks on:
    - `promotion_eligible_total <= 0`
    - empirical jobs not ready
    - DSPy live runtime not ready
    - `dependency_quorum != allow`
    - live promotion disabled
  - if those checks pass, the function upgrades `shadow` to `0.10x canary`
  - the gate does not directly consume:
    - `critical_toggle_parity`
    - Jangar market-context health
    - Jangar quant latest-store health
    - options-lane auth/bootstrap state
- `services/torghut/app/trading/hypotheses.py`
  - `JangarDependencyQuorumStatus` only carries `decision`, `reasons`, and `message`
  - segment freshness, witness ids, and degradation scope are discarded before hypothesis decisions are computed
- `services/torghut/app/options_lane/catalog_service.py`
  - constructs `OptionsRepository(settings.sqlalchemy_dsn)` and immediately calls `ensure_rate_bucket_defaults(...)`
    at import time
- `services/torghut/app/options_lane/enricher_service.py`
  - does the same import-time default seeding

Current missing regression coverage:

- no regression proving `promotion_eligible_total = 0` cannot still yield a canary-stage live submission gate;
- no parity test proving `/readyz`, `/trading/status`, and scheduler submission consume the same capital certificate;
- no regression proving stale or `down` Jangar market-context evidence vetoes live-capital promotion;
- no regression proving `latestMetricsCount = 0` plus `emptyLatestStoreAlarm = true` vetoes live-capital promotion;
- no regression proving options DB auth failure yields typed escrow state instead of boot crash.

### Database and data-quality evidence

The data layer shows why local optimism is unsafe:

- Torghut database schema is current, but `db-check` still reports migration-lineage warnings;
- quant control-plane latest-store evidence is empty for the paper window;
- market-context bundle freshness is far beyond its configured staleness contract;
- options services cannot establish authenticated DB access;
- evidence quality is therefore worse than the local gate payload suggests.

The missing primitive is not "more health checks." It is one certificate that binds profitability evidence, witness
freshness, and lane-specific dependency requirements into the same promotion decision.

## Problem statement

Torghut still lacks a profit-critical answer to four questions:

1. Which evidence bundle authorized the current capital stage?
2. Why is capital allowed above `shadow` when promotion-eligible count is `0`?
3. Which dependency segments are mandatory for this hypothesis or lane, and which ones are currently missing?
4. How should options-lane auth/bootstrap failures affect options-dependent hypotheses without freezing unrelated lanes?

Without that contract, the service can remain operationally "up" while profit authority is materially untrustworthy.

## Alternatives considered

### Option A: tighten the existing local live-submission gate

Summary:

- add more blocking conditions to `_build_live_submission_gate_payload(...)`;
- keep local status and scheduler logic as the main authority.

Pros:

- smallest code delta;
- fast to implement.

Cons:

- keeps profit authority fragmented across several code paths;
- still depends on lossy Jangar dependency payloads;
- does not create a reusable certificate for deployer rollouts or postmortems.

### Option B: freeze all promotion whenever any dependency is degraded

Summary:

- one degraded evidence source forces the whole runtime back to `shadow` or `observe`.

Pros:

- simple to reason about;
- safer than the current optimistic behavior.

Cons:

- destroys segment isolation and future option value;
- options-lane auth failures would freeze unrelated equity or market-context sleeves;
- profitability becomes too coarse to scale safely.

### Option C: cross-plane profit certificate plus options-auth isolation

Summary:

- Jangar publishes witness-backed rollout authority;
- Torghut adds local profit evidence and emits one authoritative profit certificate;
- options auth/bootstrap failures become typed, lane-scoped veto inputs rather than startup crashes.

Pros:

- unifies scheduler, `/readyz`, and `/trading/status` around one decision artifact;
- blocks false promotion when evidence is contradictory or stale;
- preserves lane-local firebreaks instead of whole-system freezes.

Cons:

- broader persistence and wiring work;
- introduces certificate expiry and replay concepts;
- requires careful staged rollout to avoid noisy vetoes.

## Decision

Adopt **Option C**.

Torghut should not authorize non-observe capital from local heuristics. It should authorize capital only from a
certificate that proves the required evidence is present, aligned, and fresh.

## Proposed architecture

### 1. Cross-plane profit certificate

Add a durable profit-certificate object, stored in Torghut and referenced from Jangar:

- `profit_certificates`
  - key: `{candidate_id, certificate_epoch_id}`
  - fields:
    - `decision` in `{observe, canary, live, quarantine}`
    - `blocking_reasons[]`
    - `required_witnesses[]`
    - `jangar_covenant_id`
    - `market_context_ref`
    - `quant_latest_store_ref`
    - `options_bootstrap_ref`
    - `toggle_parity_ref`
    - `hypothesis_summary_ref`
    - `published_at`
    - `expires_at`
- `profit_certificate_segments`
  - segment rows for:
    - `jangar_rollout_authority`
    - `market_context`
    - `quant_latest_store`
    - `toggle_parity`
    - `empirical_jobs`
    - `options_auth`
    - `options_bootstrap`
    - `simulation_capacity`

`/readyz`, `/trading/status`, and scheduler submission must all consume the same certificate id.

### 2. Profit-certificate veto rules

Mandatory veto rules for any decision above `observe`:

- `promotion_eligible_total > 0`
- `critical_toggle_parity.status = aligned`
- Jangar witness covenant decision = `allow`
- Jangar market-context state is not `down` and freshness is within lane policy
- Jangar quant latest-store evidence is non-empty for the target window
- required empirical jobs are ready
- any required options segment is healthy for options-dependent hypotheses

If one of those is false, the certificate must be `observe` or `quarantine`. It must never auto-upgrade `shadow` to
`0.10x canary` from a local optimistic shortcut.

### 3. Readiness versus promotion separation

Separate process readiness from profit authority:

- process readiness may remain `200` when the service can still serve status, logs, and control requests;
- profit readiness is represented by the certificate decision and exposed explicitly in:
  - `/readyz`
  - `/trading/status`
  - scheduler telemetry

Required invariant:

- if the active certificate decision is `observe` or `quarantine`, live submission must be disabled even if the process
  itself is otherwise healthy.

### 4. Options-auth isolation

Replace import-time DB/auth side effects with an explicit bootstrap state machine:

- `options_bootstrap_escrows`
  - states:
    - `starting`
    - `auth_invalid`
    - `schema_unready`
    - `image_unavailable`
    - `warming`
    - `healthy`
- options catalog and enricher do not crash the process during auth/bootstrap initialization;
- they emit typed escrow status and evidence refs;
- options-dependent hypotheses and sleeves consume the escrow status as a required segment;
- non-options hypotheses remain governed by their own required segments and are not globally frozen by options-only
  failures.

### 5. Implementation scope

Engineer stage must implement:

- certificate persistence and one pure certificate builder module consumed by:
  - `/readyz`
  - `/trading/status`
  - scheduler submission
- direct consumption of Jangar witness-covenant payloads instead of coarse quorum-only payloads;
- options bootstrap state machine and escrow persistence;
- typed mapping from hypothesis requirements to certificate segments;
- status payload changes so the active certificate id and veto reasons are visible to deployers.

## Validation and acceptance gates

Engineer acceptance gates:

- add a regression proving `promotion_eligible_total = 0` cannot produce `allowed = true` or `capital_stage = "0.10x canary"`;
- add a parity regression proving `/readyz`, `/trading/status`, and scheduler submission consume the same certificate id;
- add a regression proving `critical_toggle_parity.status = diverged` forces `observe` or `quarantine`;
- add a regression proving `latestMetricsCount = 0` plus `emptyLatestStoreAlarm = true` vetoes live promotion;
- add a regression proving `market_context.overallState = down` vetoes live promotion for hypotheses that require
  market-context freshness;
- add a regression proving options DB auth failure yields `options_auth = block` escrow state without crashing the
  whole lane.

Deployer acceptance gates:

- do not promote while the active certificate is missing, expired, or different across `/readyz` and `/trading/status`;
- do not promote any options-dependent lane while `options_auth` or `options_bootstrap` is not healthy;
- verify one forced rollback from canary back to `observe` caused by stale market-context or empty quant latest-store
  evidence;
- verify one isolation drill where options auth fails but non-options hypotheses remain constrained only by their own
  required segments.

## Rollout plan

1. Emit certificates in advisory mode and include the certificate id in `/trading/status`.
2. Diff advisory certificate decisions against the current local gate for at least one trading session.
3. Switch `/readyz` and `/trading/status` to certificate-backed responses.
4. Switch scheduler submission to require the certificate.
5. Enable options-bootstrap escrow and remove import-time boot seeding from the hot path.
6. Only then permit deployer promotion based on certificate state.

## Rollback plan

If certificate enforcement is too strict or noisy:

- keep writing certificate rows and options escrow rows;
- disable hard enforcement with a feature flag so the legacy council remains read-only authority temporarily;
- preserve certificate ids and evidence refs for diagnosis;
- re-enable enforcement only after the noisy segments are corrected.

Rollback is GitOps and PR-driven only. Do not patch live services by hand to bypass certificate vetoes.

## Risks and open questions

- market-close windows can look like stale signal windows if freshness rules are not session-aware;
- certificate expiry windows that are too short can cause oscillation;
- options escrow must not become another silent stale cache;
- deployers will need clear tooling to query certificate ids and segment refs quickly.

## Handoff to engineer

- build the certificate module before editing multiple gate call sites;
- carry the certificate id through logs, status, and scheduler traces;
- keep options escrow lane-scoped and typed;
- make every veto reason explicit enough for deployers to act on without source-code lookup.

## Handoff to deployer

- promote only from the active certificate, never from inferred local status;
- use certificate segment refs as the primary investigation surface when promotion is blocked;
- verify rollback by observing certificate transition and capital-stage demotion, not only pod health;
- treat options-auth failures as lane-scoped vetoes, not as blanket permission to ignore evidence quality.
