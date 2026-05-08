# Swarm Agentic Mission Architecture Notes (2026-05-08)

Status: Proposed operating guidance
Source: YouTube automatic-caption transcript for `The Multi-Agent Architecture That Actually Ships - Luke Alvoeiro, Factory`, video id `ow1we5PzK-o`, retrieved 2026-05-08.

This document records the useful system-design lessons from the transcript and translates them into the Jangar and Torghut swarm operating model. It is intentionally concise. The transcript itself is not checked into the repo; this is a derived implementation guide.

## Core Thesis

The bottleneck is human attention, not model intelligence. A useful swarm should let a human choose the goal and constraints, then let the system execute, verify, repair, and report over hours or days without constant supervision.

For this repo, that means the swarm is only useful when it moves business metrics:

- Jangar: fewer failed runs, faster green PR-to-rollout loops, lower operator attention, healthier control-plane automation.
- Torghut: more routeable profitable hypotheses, stronger post-cost proof, safer live/paper capital gates, fewer zero-notional or stale-evidence loops.

Architecture documents alone are not value. A mission produces value only when it ends in verified code, rollout, runtime evidence, or a concrete blocked-business metric with the smallest next fix.

## Agent Patterns To Use

The transcript describes five common multi-agent patterns. Jangar should use four of them deliberately:

- Delegation: an orchestrator assigns bounded work to workers.
- Creator/verifier: implementation and validation are separate contexts.
- Broadcast: every run publishes shared state, constraints, blockers, and handoff summaries.
- Negotiation: follow-up work is scoped at milestone boundaries when validation finds gaps.

Direct peer-to-peer agent communication should stay limited. It fragments state unless there is a canonical mission ledger. The shared channel is useful only if it feeds a single source of truth.

## Three Roles

The production swarm should keep three roles with strict responsibilities.

### Orchestrator

Maps to Jangar `discover` and `plan`.

Responsibilities:

- clarify the goal and business metric;
- inspect current repo, CI, GitOps, and runtime state;
- write the plan and validation contract before implementation starts;
- split work into serial milestones;
- assign workers clear ownership;
- rescope follow-up work when validation fails.

The orchestrator should not keep producing design text after the validation contract is good enough. It should feed implementers.

### Worker

Maps to `implement`.

Responsibilities:

- start from clean context and a bounded spec;
- edit only assigned files;
- commit production code and tests;
- run the smallest meaningful validation first, then broader gates as risk requires;
- produce a structured handoff with changed files, commands, exit codes, open issues, and rollback notes.

Workers must be serial for writable work. Parallel workers are acceptable only when ownership is disjoint and the orchestrator can integrate them without conflict.

### Validator

Maps to `verify`.

Responsibilities:

- use fresh context;
- treat implementation as untrusted until proven;
- run scrutiny checks: format, lint, type checks, tests, code review;
- run behavior checks: live app, endpoint, cluster, GitOps, or user-flow verification;
- open follow-up work instead of silently accepting partial success.

Validation is adversarial by design. The validator should not share the worker's cost bias.

## Validation Contract

Every mission needs a validation contract written before code.

The contract defines correctness independently from the implementation. Tests written only after code often confirm the implementation instead of proving the goal. The contract should list assertions such as:

- what user or operator behavior must work;
- what runtime endpoint must return;
- which CI jobs must pass;
- which GitOps revision must sync;
- which rollout or rollback condition must be observed;
- which business metric must improve, unblock, or be honestly reported as blocked.

Each feature must map to one or more assertions. A mission is not complete until all assertions are either satisfied or converted into an explicit follow-up blocker.

## Execution Cadence

Writable implementation should be mostly serial. The transcript's key warning is that broad parallel coding looks faster but creates conflicts, duplicated work, and inconsistent architecture.

Allowed parallelism:

- read-only code search;
- API or docs research;
- independent code review;
- log and cluster evidence gathering;
- test-plan drafting.

Disallowed by default:

- multiple agents editing the same files;
- multiple agents changing the same runtime contract;
- direct deployment mutations outside GitOps;
- architecture-only loops that do not feed implementation.

The default Jangar/Torghut cadence should bias toward implementation and verification, with discover/plan running slower unless a real blocker requires new architecture. Current swarm cadence should remain in that shape: more implement capacity than architect capacity, and verify frequent enough to close the loop.

## Handoffs

Every worker and validator handoff must be structured enough for the next agent to continue without guessing.

Required handoff fields:

- objective;
- files changed or inspected;
- commands run and exit codes;
- tests that passed or failed;
- unresolved issues;
- risk and rollback notes;
- exact next action.

`I'm done` is not a handoff. A useful handoff is an audit record.

## Mission Ledger

Long-running swarm work needs one canonical ledger. Broadcast messages are useful only when they update or point to that ledger.

The ledger should record:

- mission id;
- goal and business metric;
- plan and validation contract;
- current milestone;
- worker/validator handoffs;
- PR, commit, CI, and rollout refs;
- follow-up features created from validation failures;
- final runtime evidence.

Jangar should treat missing or stale ledger evidence as a system fault, not as a successful run with weak notes.

## Model And Tool Assignment

No single model or provider should be assumed best for every role.

Guidance:

- planning benefits from slower careful reasoning;
- implementation benefits from fast code fluency and local repo context;
- validation benefits from precise instruction following and fresh context;
- critical validation can use a different model family to reduce shared blind spots.

The deterministic controller logic should stay thin: scheduling, bookkeeping, validation blocking, handoff persistence, and progress gates. Decomposition and repair strategy should live mostly in prompts, skills, and mission instructions so the system improves as models improve.

## Business-Value Gates For Jangar And Torghut

### Jangar

Jangar missions must tie work to at least one of:

- reduced failed AgentRuns or failed schedule jobs;
- faster PR merge to healthy GitOps rollout;
- improved `/ready` or control-plane status truth;
- fewer manual interventions;
- stronger evidence persistence and handoff quality.

Done requires code or config merged, Argo synced, runtime health verified, and the handoff ledger updated.

### Torghut

Torghut missions must tie work to at least one of:

- post-cost daily net PnL improvement;
- higher routeable candidate count;
- lower zero-notional or stale-evidence rate;
- better fill, TCA, or slippage evidence;
- safer capital gates that prevent bad live submissions.

Done requires tests, PR merge, image promotion when code changes runtime, live service health, and proof that `/trading/status` or the relevant evidence surface reflects the change.

## Anti-Patterns

Avoid these:

- more architect runs than implement runs;
- docs that do not create implementable work;
- validators using the same context and assumptions as workers;
- broad parallel writes;
- status messages with no PR, commit, CI, runtime, or metric reference;
- green CI used as a substitute for live behavior checks;
- direct agent chatter without a ledger update;
- declaring rollout complete from Argo sync alone.

## Minimal Operating Loop

Use this loop for each mission:

1. Orchestrator writes goal, business metric, plan, and validation contract.
2. Worker implements one bounded milestone.
3. Worker commits and publishes structured handoff.
4. Validator runs scrutiny and behavior checks from fresh context.
5. If validation fails, orchestrator creates follow-up feature work.
6. If validation passes, merge through normal PR gates.
7. GitOps promotes runtime changes.
8. Validator proves live runtime and business metric impact.
9. Ledger records final evidence and next target.

That is the swarm architecture that should ship here: fewer roles doing more useful work, stronger validation before completion, and business-value evidence at the end of every loop.
