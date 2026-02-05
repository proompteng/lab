# Audit Logging for Autonomous Actions

Status: Draft (2026-02-04)

## Problem
High scale PR automation needs traceable audit logs.

## Goals
- Emit audit logs for run submissions and PR actions.
- Include correlation ids and repo context.

## Non-Goals
- A full SIEM integration.

## Design
- Structured logs with consistent fields.
- Optional audit log sink configuration.

## Chart Changes
- Expose audit log settings in values.

## Controller Changes
- Emit audit events on key actions.

## Acceptance Criteria
- Audit logs include agentRun uid and repo.
- Audit sink can be enabled by values.
