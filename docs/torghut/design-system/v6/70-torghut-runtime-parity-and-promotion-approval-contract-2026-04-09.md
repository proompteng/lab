# 70. Torghut Runtime Parity and Promotion Approval Contract (2026-04-09)

Status: Proposed (`design`)
Date: `2026-04-09`
Owner: Codex
Scope: Remove the gap between research-harness winners and real runtime behavior so Torghut can stop promoting false positives.

Extends:

- `docs/torghut/design-system/v6/68-torghut-strategy-factory-formal-validity-and-sequential-promotion-2026-04-04.md`
- `docs/torghut/design-system/v6/69-torghut-harness-v2-strategy-discovery-and-whitepaper-research-factory-2026-04-07.md`
- `docs/torghut/design-system/v6/67-torghut-trading-engine-glossary-and-mechanics-2026-03-29.md`

## Executive summary

Torghut currently has a critical integrity problem:

- the research harness can declare a candidate attractive;
- that candidate can still fail once encoded into the actual runtime and replayed through scheduler-v3;
- the system therefore has two different notions of "winner."

That is unacceptable.

The design decision in this document is:

1. discovery stops being a promotion authority;
2. scheduler-v3 replay becomes the only approval authority;
3. research survives only if it is runtime-parity-correct;
4. promotion becomes impossible for `/tmp` artifacts, notebook-only composites, or evaluator-only families.

The immediate goal is not to discover a new strategy faster.

The immediate goal is to make it impossible to lie to ourselves about one.

## Problem statement

The current harness has been useful as a hypothesis generator, but it failed the bar that matters:

- it produced a research-only candidate that appeared to clear the profitability target;
- the candidate did not survive the real runtime path;
- the earlier language around that candidate overstated its quality.

This failure mode has four concrete causes:

1. research evaluation and runtime evaluation are still not the same code path;
2. adaptive compositions can exist in discovery without existing as first-class runtime families;
3. scheduler/runtime state enrichment can diverge from research enrichment;
4. promotion language was allowed to get ahead of runtime-backed evidence.

## Hard decision

Effective immediately, Torghut must adopt these rules:

1. No research-only winner can be called promotable.
2. No `/tmp` artifact can be treated as a deployment candidate.
3. No notebook result can bypass checked-in runtime implementation.
4. No family can be promoted unless scheduler-v3 replay matches the research result on the same window.

## Goals

1. make research and runtime produce the same decisions for the same input window;
2. prevent discovery-only families from entering promotion language or workflow;
3. define one approval path that all candidates must pass;
4. make failures attributable with parity artifacts instead of guesswork;
5. preserve the useful parts of the research harness as a search surface, not as an oracle.

## Non-goals

1. declaring the current harness worthless for all purposes;
2. replacing scheduler-v3 with the research harness;
3. introducing another parallel evaluator;
4. promoting any candidate during this parity repair phase.

## Source of truth

The only promotable candidate is one that exists in all four places:

1. checked-in runtime family/config in repo;
2. runtime decision support in:
   - `services/torghut/app/trading/strategy_runtime.py`
   - `services/torghut/app/trading/decisions.py`
   - any required scheduler/session enrichment path;
3. scheduler-v3 replay artifact on the target window;
4. approval record derived from that scheduler-v3 replay.

Research outputs remain useful for ranking and search-budget allocation, but they do not define promotability.

## Required architecture change

### 1. Unify decision authority

Research and runtime must share one family-evaluation authority.

Required result:

- the family definition that search mutates must compile into the same runtime path that scheduler-v3 executes;
- no alternative evaluator may create a "winning" decision surface unavailable to runtime.

Implication:

- research can still orchestrate search, mutation, and ranking;
- research can no longer own the final action-generation semantics.

### 2. Add a parity gate

Every candidate that survives search must pass a parity check on the same window:

- research replay output
- runtime plugin output
- scheduler-v3 replay output

All three must agree on:

- action sequence;
- direction;
- entry/exit timing;
- notional scaling semantics;
- session activity days.

If they diverge, the candidate is invalid.

### 3. Ban research-only family classes from promotion

The following are explicitly non-promotable:

- notebook compositions that do not exist as runtime families;
- `/tmp` JSON artifacts with no checked-in family definition;
- ad hoc adaptive selectors not compiled into runtime;
- search-local overrides that cannot survive runtime replay.

### 4. Make scheduler-v3 replay the approval oracle

Promotion approval must be computed from scheduler-v3 replay artifacts, not research-harness artifacts.

Research may still score candidate quality, but final gates must use scheduler-v3 outputs for:

- active day count;
- average daily PnL;
- median daily PnL;
- best-day share;
- worst-day loss;
- max drawdown;
- day-level sign stability.

## Approval workflow

### Stage A: Search

Search may use the harness to:

- mutate families;
- prune dominated candidates;
- rank opportunities;
- store notebooks and diagnostics.

But every survivor must become a checked-in runtime candidate before it can advance.

### Stage B: Runtime parity replay

For each survivor:

1. compile or encode the candidate as a runtime family;
2. replay it through scheduler-v3 on the same target window;
3. compare research and runtime outputs;
4. reject on any mismatch.

### Stage C: Approval replay

For parity survivors only:

1. run scheduler-v3 replay on train window;
2. run scheduler-v3 replay on unseen validation window;
3. compute approval metrics from runtime artifacts;
4. reject anything with flat-day gaps, concentration spikes, or poor downside behavior.

### Stage D: Shadow

Before promotion:

1. run paper/shadow in the live runtime path;
2. compare shadow behavior to approval replay behavior;
3. reject on drift.

### Stage E: Promotion

Only after shadow parity holds may:

- `strategy-configmap.yaml` be updated;
- canary/live rollout begin.

## Required code changes

The implementation program must deliver at least:

1. shared runtime-backed family evaluation interface for research and replay;
2. parity artifact writer that emits research-vs-runtime comparisons;
3. CI tests that fail on evaluator drift;
4. promotion gate changes that require scheduler-v3-backed evidence;
5. notebook/UI labeling that distinguishes:
   - research candidate
   - parity-qualified candidate
   - approval-qualified candidate
   - promoted candidate

## Safety rules

During this transition:

1. do not promote any new strategy from the current harness output;
2. do not describe a candidate as a winner unless it has runtime parity and approval replay;
3. do not treat observed-window-only research artifacts as rollout evidence.

## Acceptance criteria

This design is only complete when all of the following are true:

1. a candidate cannot be marked promotable without scheduler-v3 replay evidence;
2. research-only families cannot pass promotion gating;
3. parity tests exist for all active family classes;
4. notebooks and reports clearly label non-promotable research artifacts;
5. at least one historical false-positive candidate is shown to fail parity in an explicit regression test or fixture;
6. the next promoted strategy, if any, comes from the unified runtime-backed workflow.

## Blunt conclusion

Torghut does not currently have a trustworthy promotion harness.

It has a useful search harness and a separate runtime authority.

This document resolves that conflict by making runtime authority final and forcing research to prove parity before it is allowed to influence rollout.
