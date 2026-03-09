# 35. Alpaca Options Production Hardening and OPRA Promotion (2026-03-08)

## Status

- Date: `2026-03-08`
- Maturity: `implementation-ready design`
- Scope: `argocd/applications/torghut-options/**`, `argocd/applications/torghut/**`,
  `services/torghut/app/options_lane/**`,
  `services/dorvud/technical-analysis-flink/**`, Torghut Postgres/ClickHouse/Kafka,
  and the live `torghut` / `argocd` clusters
- Depends on:
  `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md` and
  `34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`
- Primary objective: harden the already-deployed options lane, prove regular-session
  behavior, and promote it from `indicative` soak to `opra` without turning the
  live lane into an opaque cutover gamble
- Non-goals: options order execution, strategy enablement, or permanent duplicate
  production feeds

## Executive Summary

Torghut now has a live options ingest and technical-analysis lane, but that is not
the same thing as a production-complete lane. The current deployment is healthy on
`2026-03-08`, yet it still runs on `indicative`, was validated during a closed
session, initializes ClickHouse schema inside Flink startup, and does not extend the
existing ClickHouse guardrail surface to the new options tables.

The next implementation wave is therefore operational hardening, not new trading
behavior.

This document fixes that boundary:

- no options strategy or capital allocation work is allowed to bypass the hardening
  wave;
- feed promotion happens in three stages: `indicative` soak, `opra` shadow, then
  `opra` primary;
- ClickHouse schema bootstrap moves out of the main Flink startup path;
- options-specific session validation, guardrails, and provider-cap evidence become
  first-class operating contracts.

The design deliberately treats the current deployed lane as a valuable baseline, but
not as the final production shape.

## Context

Documents 33 and 34 correctly solved the first-order design problem: create a
separate options lane rather than trying to retrofit the equity lane. That decision
was right, and the lane now exists. The remaining gap is subtler and more dangerous:
operators can see pods, topics, and checkpoints, but they still do not have a
disciplined promotion contract for live market-open proof, provider-cap learning, or
`opra` cutover.

Options data is especially hostile to wishful rollout thinking:

- a closed session can look healthy even when no real-time rows are flowing;
- `indicative` is a useful bootstrap feed but not the terminal production answer;
- provider symbol limits and subscription churn can look stable until the first busy
  open;
- schema initialization inside Flink startup hides infra problems inside the hot
  runtime path.

That makes this hardening wave the last mandatory step before any options strategy or
execution design should be treated as credible.

## Verified Current State

### The options lane is live and healthy, but only on a closed-session baseline

Live cluster inspection on `2026-03-08` shows:

- Argo application `torghut-options` is `Synced` and `Healthy`;
- `Deployment/torghut-options-catalog`,
  `Deployment/torghut-options-enricher`, and
  `Deployment/torghut-ws-options` are all available;
- `FlinkDeployment/torghut-options-ta` reports
  `lifecycleState=STABLE`, `jobManagerDeploymentStatus=READY`, and
  `jobStatus.state=RUNNING`;
- Postgres contains the active options catalog and subscription state;
- ClickHouse tables exist, but row counts remained `0` during Sunday-evening
  verification, which is session-consistent rather than proof of a market-open path.

This means the lane is deployed and restart-safe enough to inspect, but it does not
yet have a documented regular-session promotion record.

### The live lane still runs on `indicative`

The current production manifests are still `indicative`-backed:

- [`argocd/applications/torghut-options/ws/configmap.yaml`](argocd/applications/torghut-options/ws/configmap.yaml)
  sets `ALPACA_FEED="indicative"`;
- [`argocd/applications/torghut-options/enricher/configmap.yaml`](argocd/applications/torghut-options/enricher/configmap.yaml)
  sets `ALPACA_OPTIONS_FEED="indicative"`;
- [`argocd/applications/torghut-options/ta/configmap.yaml`](argocd/applications/torghut-options/ta/configmap.yaml)
  sets `OPTIONS_TA_FEED="indicative"`.

Document 33 explicitly selected `opra` as the production target. That target has not
been realized yet.

### Existing ClickHouse guardrails still only understand the equity TA tables

[`argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter-configmap.yaml`](argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter-configmap.yaml)
still defaults `CLICKHOUSE_REPLICATED_TABLES` to `ta_signals,ta_microbars`, and its
freshness state is hard-coded around those two table families.

That means the current replicated-table guardrail surface cannot tell operators
whether:

- `options_contract_bars_1s` is fresh,
- `options_contract_features` is fresh, or
- `options_surface_features` is fresh.

### ClickHouse schema creation still happens inside the Flink startup path

[`services/dorvud/technical-analysis-flink/src/main/kotlin/ai/proompteng/dorvud/ta/flink/OptionsTechnicalAnalysisJob.kt`](services/dorvud/technical-analysis-flink/src/main/kotlin/ai/proompteng/dorvud/ta/flink/OptionsTechnicalAnalysisJob.kt)
calls `ensureOptionsClickhouseSchema(config)` before wiring the three ClickHouse
sinks.

That startup contract already produced one transient
`MEMORY_LIMIT_EXCEEDED` recovery during rollout. The retry path recovered, but the
design is still wrong: schema bootstrap is infra prep, not hot-path stream
responsibility.

### Provider-cap configuration is live, but the source-of-truth is split

[`services/torghut/app/options_lane/settings.py`](services/torghut/app/options_lane/settings.py)
defaults `OPTIONS_PROVIDER_CAP_BOOTSTRAP` to `500`, while the deployed options
manifests currently set `OPTIONS_PROVIDER_CAP_BOOTSTRAP="200"` in:

- [`argocd/applications/torghut-options/catalog/configmap.yaml`](argocd/applications/torghut-options/catalog/configmap.yaml)
- [`argocd/applications/torghut-options/ws/configmap.yaml`](argocd/applications/torghut-options/ws/configmap.yaml)
- [`argocd/applications/torghut-options/enricher/configmap.yaml`](argocd/applications/torghut-options/enricher/configmap.yaml)

That mismatch is survivable, but it is the wrong shape for a production promotion
process because operators do not yet have a durable provider-cap observation ledger.

### There is no dedicated market-open validation workflow today

Repository search over `services/torghut/scripts`,
`argocd/applications/torghut-options`, and `argocd/applications/torghut` shows no
options-specific market-open validation or `opra` shadow workflow. The current lane
can be observed manually, but it cannot yet produce a repeatable proof artifact for
first-trade, first-quote, first-snapshot, first-derived-row, or provider-cap
acceptance.

## Design Decision

### Decision 1: hardening precedes all options strategy and execution work

No options strategy, execution, or capital-allocation implementation may be treated
as production-ready until this hardening wave is complete. A lane that only proved
closed-session health on `indicative` does not yet deserve live trading behavior.

### Decision 2: promote in three stages, not a single `indicative -> opra` cut

Promotion proceeds in three explicit stages:

1. `indicative` primary soak
2. `opra` shadow lane
3. `opra` primary lane

The shadow stage is mandatory because it lets Torghut observe provider-cap pressure,
first-open behavior, and derived-table freshness without risking the only running
options lane.

### Decision 3: schema bootstrap is an infra step, not a stream startup step

The Flink job must assume tables already exist. Schema creation moves to an explicit
bootstrap unit controlled by GitOps rollout order, not by job startup retries.

### Decision 4: options freshness and provider-cap evidence must be session-aware

Weekend and holiday closed sessions are not incidents. The system must distinguish:

- no rows because the market is closed;
- no rows because the lane is unhealthy;
- degraded breadth because provider-cap pressure reduced the hot set;
- blocked breadth because the lane is receiving hard provider rejections.

### Decision 5: guardrails must cover both primary and shadow lanes during promotion

The temporary `opra` shadow lane is a first-class production dependency during
promotion. It therefore gets the same freshness, checkpoint, and rollout evidence
surface as the primary lane.

## Selected Architecture

### Components

The hardening wave introduces four explicit operating components:

| Component | Type | Responsibility |
| --- | --- | --- |
| `torghut-options-ta-schema-bootstrap` | `Job` or Argo CD PreSync hook | Create/verify options ClickHouse tables and Karapace subjects before Flink starts |
| `torghut-options-open-validation` | script plus on-demand `Job` | Capture market-open proof artifacts for quotes, trades, snapshots, derived rows, and provider-cap pressure |
| `torghut-options-opra-shadow` | temporary GitOps application | Run the same options topology on `opra` with isolated topics, tables, and credentials during promotion |
| `torghut-clickhouse-guardrails-exporter` extension | config plus exporter update | Add options table freshness, shadow-table freshness, and session-aware labels to the existing guardrail surface |

### Promotion topology

#### Stage A: `indicative` primary soak

The currently deployed lane remains the primary options lane while hardening changes
land. Its purpose is to keep:

- contract discovery,
- subscription rotation,
- snapshot enrichment,
- Flink checkpointing, and
- operator dashboards

stable while the hardening layer is added around it.

#### Stage B: `opra` shadow

Create a temporary `argocd/applications/torghut-options-shadow` application in the
same `torghut` namespace. It reuses the codebase, but not the topics, tables, or
Kafka principal.

The shadow lane uses:

- `ALPACA_FEED=opra`,
- `ALPACA_OPTIONS_FEED=opra`,
- `OPTIONS_TA_FEED=opra`,
- shadow Kafka topic names under `torghut.options.shadow.*`,
- shadow ClickHouse tables under `options_shadow_*`,
- a dedicated Kafka principal such as `KafkaUser/torghut-options-shadow`.

This gives Torghut side-by-side feed evidence without corrupting the primary lane's
truth.

#### Stage C: `opra` primary

After shadow gates pass, the primary `torghut-options` application is flipped to
`opra` and the shadow lane remains alive only long enough to compare one more regular
session. After that confirmation session, the shadow lane is removed.

### Schema bootstrap contract

`torghut-options-ta-schema-bootstrap` owns:

- `CREATE TABLE IF NOT EXISTS` for the three primary options tables;
- `CREATE TABLE IF NOT EXISTS` for the three shadow tables during Stage B;
- any required Karapace schema registration or schema subject existence checks;
- idempotent success/failure reporting.

The Flink job loses responsibility for schema creation. It may still verify table
reachability, but it must not create schema objects on startup.

### Market-open validation contract

`torghut-options-open-validation` runs at operator request or via an automated
workflow for every regular session used as a promotion gate. It records:

- first successfully authenticated websocket session time;
- first quote event time;
- first trade event time;
- first snapshot publish time;
- first `torghut.options.ta.contract-bars.1s.v1` event time;
- first ClickHouse row times for `options_contract_bars_1s`,
  `options_contract_features`, and `options_surface_features`;
- maximum hot-set breadth accepted without `405`;
- any `406`, `410`, `412`, `413`, or `429` status bursts.

The validator produces both machine-readable JSON and a small operator summary.

## Interfaces and Data Contracts

### Shadow lane Kafka contracts

The `opra` shadow stage adds the following temporary contracts:

- `torghut.options.shadow.contracts.v1`
- `torghut.options.shadow.trades.v1`
- `torghut.options.shadow.quotes.v1`
- `torghut.options.shadow.snapshots.v1`
- `torghut.options.shadow.status.v1`
- `torghut.options.shadow.ta.contract-bars.1s.v1`
- `torghut.options.shadow.ta.contract-features.v1`
- `torghut.options.shadow.ta.surface-features.v1`
- `torghut.options.shadow.ta.status.v1`

These topics are temporary rollout artifacts, not long-term public product
interfaces. They are deleted after Stage C cleanup.

### Shadow lane ClickHouse tables

During Stage B, the shadow lane writes to:

- `options_shadow_contract_bars_1s`
- `options_shadow_contract_features`
- `options_shadow_surface_features`

Primary and shadow data must never share the same derived tables.

### Rollout evidence tables

Postgres becomes the authority for promotion evidence via two new tables:

#### `public.torghut_options_rollout_sessions`

| Column | Type | Notes |
| --- | --- | --- |
| `session_date` | `date` | US market session date |
| `lane` | `text` | `primary` or `shadow` |
| `feed` | `text` | `indicative` or `opra` |
| `phase` | `text` | `soak`, `shadow`, `promotion`, `post-cutover` |
| `status` | `text` | `running`, `passed`, `failed`, `aborted` |
| `started_at` | `timestamptz` | validator start |
| `finished_at` | `timestamptz` | validator finish |
| `first_quote_ts` | `timestamptz` | first quote event observed |
| `first_trade_ts` | `timestamptz` | first trade event observed |
| `first_snapshot_ts` | `timestamptz` | first snapshot publish observed |
| `first_contract_bar_ts` | `timestamptz` | first TA contract bar |
| `first_clickhouse_bar_ts` | `timestamptz` | first ClickHouse contract bar |
| `first_clickhouse_feature_ts` | `timestamptz` | first ClickHouse contract feature |
| `first_clickhouse_surface_ts` | `timestamptz` | first ClickHouse surface feature |
| `summary_json` | `jsonb` | compact validator report |

#### `public.torghut_options_provider_cap_observations`

| Column | Type | Notes |
| --- | --- | --- |
| `observed_at` | `timestamptz` | observation time |
| `lane` | `text` | `primary` or `shadow` |
| `feed` | `text` | `indicative` or `opra` |
| `requested_hot_contracts` | `int` | target hot set size |
| `accepted_hot_contracts` | `int` | confirmed live breadth |
| `rejected_hot_contracts` | `int` | contracts rejected or dropped |
| `error_code` | `text` | provider code such as `405` |
| `detail` | `text` | operator-readable detail |
| `generation` | `int` | provider-cap generation at the time |

### Guardrail contract

The ClickHouse guardrails exporter must accept a configurable table set rather than
assuming only equity tables. In the hardening wave it must cover:

- `ta_signals`
- `ta_microbars`
- `options_contract_bars_1s`
- `options_contract_features`
- `options_surface_features`
- `options_shadow_contract_bars_1s`
- `options_shadow_contract_features`
- `options_shadow_surface_features`

and export a `session_state` label so closed-session gaps do not page operators as if
they were live-session incidents.

## Failure Modes and Ops

### Provider-cap collapse during `opra` shadow

If the shadow lane produces repeated `405` or `413` responses, the promotion gate
fails immediately. The response is to reduce hot breadth, persist the observation,
and rerun the next regular session, not to cut over anyway.

### Schema bootstrap failure

If schema bootstrap fails, Flink does not start. That is intentional. Infra failure is
easier to reason about before stream startup than after a partially initialized job
begins retrying.

### Weekend and holiday false positives

Validation and freshness alerts must use session state from the same calendar policy
as the enricher and catalog. Closed-session `0` rows are not actionable unless an
operator explicitly asked for a replay or a scheduled validation run.

### Shadow and primary divergence

If `opra` shadow and `indicative` primary diverge materially in first-open latency,
hot-set breadth, or derived freshness, the promotion stops until the cause is
explained. The lane must not silently treat shadow data as "just different."

## Rollout Phases

### Phase 1: hardening primitives

- add schema bootstrap job
- remove runtime schema creation from the Flink job
- extend ClickHouse guardrails to options tables
- add rollout evidence tables and market-open validator

### Phase 2: `opra` shadow

- deploy `torghut-options-opra-shadow`
- run at least two regular sessions with market-open validation
- record provider-cap observations on every session

### Phase 3: `opra` primary cutover

- flip the primary lane to `opra`
- keep shadow alive for one further regular session
- compare primary and shadow evidence before cleanup

### Phase 4: cleanup and steady-state

- retire shadow topics, tables, and credentials
- freeze provider-cap defaults from observed evidence
- treat `opra` as the only production feed

## Acceptance Criteria

This document is complete only when all of the following are true:

- `torghut-options` runs on `opra` in production.
- No options ClickHouse schema creation happens inside Flink startup.
- The ClickHouse guardrail surface reports freshness for both equity and options
  derived tables.
- At least two consecutive `opra` shadow regular sessions pass with:
  - first quote within `2m` of open,
  - first trade within `2m` of open,
  - first snapshot within `3m` of open,
  - first ClickHouse contract bar within `5m` of open,
  - no sustained `blocked` state over `60s`,
  - no unresolved `405`, `406`, `410`, `412`, or `413` bursts.
- One further regular session passes after primary cutover.
- Provider-cap defaults in code and manifests are reconciled to an observed, durable
  source of truth.
