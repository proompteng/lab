# Topology Spread Defaults

Status: Draft (2026-02-04)

## Problem
Workloads can stack on a single node without spread rules.

## Goals
- Expose topology spread constraints at chart level.
- Allow AgentRun overrides.

## Non-Goals
- Scheduling across clusters.

## Design
- Add defaultWorkload.topologySpreadConstraints in values.
- Use controller env to pass JSON arrays.

## Chart Changes
- Add values and schema entries.
- Document usage in README.

## Controller Changes
- Parse env JSON and apply to Job pod spec.

## Acceptance Criteria
- Jobs spread across nodes when configured.
- Invalid JSON is ignored with warnings.
