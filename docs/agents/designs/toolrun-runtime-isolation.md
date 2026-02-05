# ToolRun Runtime Isolation

Status: Draft (2026-02-04)

## Problem
Tool runs need consistent isolation and resource limits.

## Goals
- Support dedicated service accounts for ToolRuns.
- Allow per-tool resource policies.

## Non-Goals
- Building a new tool execution engine.

## Design
- Allow ToolRun workload overrides similar to AgentRun.
- Expose default tool workload settings.

## Chart Changes
- Add tool workload defaults to values.

## Controller Changes
- Apply tool workload defaults when submitting ToolRun jobs.

## Acceptance Criteria
- ToolRun jobs honor resource limits.
- Dedicated service accounts are supported.
