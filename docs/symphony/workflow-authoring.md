# Symphony Workflow Authoring Guide

## Purpose

`WORKFLOW.md` is the repo-owned control surface for Symphony.

It should define:

- which Linear work is eligible
- how Codex should operate
- which hooks prepare the workspace
- what completion or handoff means for the team

## Handoff Conventions

Symphony is a scheduler, not a ticket-closing brain.

Recommended conventions:

- use active states only for work Symphony may pick up
- use explicit handoff states such as `Human Review` when human attention is required
- reserve terminal states for work that should stop and have its workspace cleaned up on reconciliation

Recommended outcome meanings:

- `Todo`: eligible if blockers are terminal
- `In Progress`: eligible
- `Human Review`: non-active handoff, Symphony stops without terminal cleanup
- `Done` / `Closed` / equivalent: terminal, Symphony stops and cleans workspace

## Validation Expectations

Workflow authors should assume Symphony validates only the scheduler-critical fields before dispatch:

- tracker kind and credentials
- project slug
- Codex command presence
- YAML/front matter structure

Everything else should still be written defensively in the prompt and hooks.

## Prompt Guidance

Prompt templates should:

- state the desired end condition clearly
- tell the agent how to validate its work
- define when to stop and hand off
- define what to do when blocked

Prompt templates should not:

- assume the orchestrator will mutate ticket state for them
- assume user interaction is available mid-turn
- rely on hidden local credentials or workstation-only tools

## Stop vs Retry

Agents should stop, not retry in-session, when:

- the issue is complete
- the next step is a human review or explicit handoff state
- the task is blocked on external input

The orchestrator will retry when:

- Codex session startup fails
- the worker crashes
- a turn stalls or times out
- retry scheduling backoff is required

Workflow prompts should distinguish:

- human/product blocking conditions
- transient execution failures

That keeps ticket behavior predictable.

## Hook Guidance

Hooks are trusted code and run inside the issue workspace.

Recommended hook responsibilities:

- `after_create`: initial clone/bootstrap for brand-new workspaces
- `before_run`: sync the repository and prepare dependencies
- `after_run`: lightweight cleanup or artifact export
- `before_remove`: best-effort cleanup before terminal workspace deletion

Hook rules:

- keep hooks idempotent
- avoid destructive resets of reused workspaces unless explicitly intended
- keep output concise because Symphony truncates hook logs
- fail early with clear shell errors when prerequisites are missing

## Policy Visibility

The live dashboard and `GET /api/v1/state` show the effective runtime policy:

- approval policy
- sandbox settings
- allowed dynamic tools
- workspace root
- concurrency
- active and terminal states

Workflow changes should be checked there after rollout to confirm the live process is using the expected policy.

## Leader-Aware Expectations

Only the elected leader dispatches work.

Authors should assume:

- leader transitions can interrupt an in-flight worker
- retries and recent issue metadata survive restart on the shared Symphony PVC
- live subprocesses do not resume after restart or leadership change

So prompts and hooks should be safe to re-enter.

## Recommended Review Checklist

Before merging a `WORKFLOW.md` change:

1. confirm the active and terminal state sets are correct
2. confirm the prompt defines a clear handoff state
3. confirm hooks are idempotent and bounded
4. confirm Codex approval and sandbox values match the intended trust posture
5. confirm the workflow does not require orchestrator-side ticket writes
