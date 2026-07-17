# Torghut Profitability Design Pack

Status: Current design and implementation handoff.

Source baseline: `9f6487ada0cf9222b65cbb1ee9b10d50a09b216e`.

Audit snapshot: `2026-07-14T05:48:00Z` through `2026-07-14T06:06:33Z`.

This directory defines the production design required to make Torghut profitability economically true, statistically
defensible, operationally safe, and independently reproducible. It does not claim that Torghut is profitable or grant
paper/live capital authority.

## Authority And Reading Order

Live source and runtime still outrank these documents. For a capital or operational decision, read in this order:

1. live broker state and immutable broker economic events;
2. `GET /readyz`, direct scheduler `GET /trading/status`, and current Argo/Kubernetes state;
3. current GitOps under `argocd/applications/torghut/**`;
4. current service code and tests under `services/torghut/**`;
5. the time-stamped audit snapshot in this directory;
6. the normative design and roadmap in this directory;
7. dated material under `docs/torghut/design-system/**` as historical rationale only.

Do not copy a runtime count, blocker, revision, account state, or candidate result from these documents without a fresh
readback. The audit snapshot records what was observed at its stated time.

## Documents

- [Current audit snapshot](current-audit-snapshot-2026-07-14.md): source, cluster, CNPG, accounting, candidate, and
  Hyperliquid evidence that motivated the design.
- [Adversarial profitability system design](adversarial-profitability-system-design.md): target architecture,
  authority boundaries, economic ledger, execution, data, risk, and proof contracts.
- [Research validation and promotion design](research-validation-and-promotion-design.md): objective function, KPI
  dictionary, causal data rules, statistical validation, capacity/TCA methodology, strategy queue, and capital ladder.
- [Strategy capital authority](strategy-capital-authority.md): immutable per-strategy grant, immediate pre-broker
  enforcement, evidence separation, catalog baseline, and live proof contract.
- [Infrastructure validation runbook](infrastructure-validation-runbook.md): v2 permit authority, exact paper-account
  boundary, one-dollar IOC proof, no-retry failure handling, and independent broker/CNPG readback.
- [Strict submit recovery](strict-submit-recovery.md): observation-only ambiguous-submit state machine, broker-specific
  evidence, atomic settlement, rate limits, fail-closed readiness, rollout proof, and rollback contract.
- [Risk-reduction mutation fencing](risk-reduction-mutation-fencing.md): one coordinator, broker-observed per-action
  permits, cancel/replace/close invariants, causal identity, fault schedules, and live proof contract.
- [Order and fill lineage repair receipts](order-lineage-repair-receipts.md): append-only order-level repair evidence,
  explicit residual classifications, and a permanent non-promotion boundary.
- [Full broker-economic TigerBeetle parity](tigerbeetle-economic-parity.md): exact versioned projection, linked-chain
  materialization, full readback, sealed evidence, entry-only enforcement, and rollout proof.
- [Implementation roadmap](implementation-roadmap.md): ordered PR-sized delivery slices, tests, rollout proof,
  dependencies, and rollback posture.
- [Slice 3 production evidence](evidence/slice-03-autoresearch-completion-2026-07-14.md): committed revision, CI and
  image chain, GitOps rollout, deployed candidate-processing exercise, safety readback, and unresolved deltas.
- [Slice 9 production evidence](evidence/slice-09-order-lineage-census-2026-07-17.md): immutable historical census,
  exact-input rerun, source-table non-mutation proof, diagnostic coverage, and remaining fresh-paper gate.

## Current Decision

Ordinary live risk-increasing submission must remain blocked. A separately bounded, expiring micro-live experiment may
become eligible only after, at minimum:

- strategy-scoped capital authority is enforced before risk-increasing broker I/O;
- every broker mutation uses durable claim and receipt fencing;
- an independent broker-activity reducer reconciles orders, fills, positions, cash, equity, fees, corrections, and
  corporate actions with zero unexplained settled delta;
- current order-feed, runtime-ledger, TCA, and TigerBeetle evidence is complete and fresh;
- the same versioned policy and execution envelope is proven through replay, shadow, and bounded paper probation;
- a candidate passes selection-adjusted statistical, after-cost, tail-risk, and capacity gates.

Scaling beyond the initial micro-live tranche requires a new completed, reconciled proof window at that tranche.
Cancellation and strictly exposure-reducing closeout must remain available when capital, profitability, data, or
accounting gates block entries. Those actions remain durably fenced and must not side-flip or increase gross/net
exposure, but they do not depend on an active candidate capital grant.

## Definition Of Done

No capability is complete because a class, migration, table, test fixture, API field, green Argo badge, or design file
exists. Material work is complete only after this common chain passes:

`reachable production code -> regression/property tests -> fault injection -> CI -> built image identity -> Argo sync -> controlled runtime observation -> capability-specific independent proof`

The terminal proof must match the capability: broker/capital work requires independent broker-economic reconciliation;
research work requires immutable receipt/trial replay reproduction; storage work requires preserved hashes plus
failover/restore evidence; operational work requires the declared fault/SLO recovery. Inapplicable proof fields are
recorded as such with a reason, never fabricated. Missing any applicable link means the capability is not
production-proven.
