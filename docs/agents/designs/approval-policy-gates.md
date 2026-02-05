# Approval Policy Gates

Status: Draft (2026-02-04)

## Problem
High-risk runs should require approval before execution.

## Goals
- Support approval gates in workflows.
- Allow multiple approval providers.

## Non-Goals
- Implementing a full approval UI.

## Design
- Add ApprovalPolicy checks in orchestration steps.
- Expose approval events via SignalDelivery.

## Chart Changes
- Document approval policies and signals.

## Controller Changes
- Pause workflows until approval is received.

## Acceptance Criteria
- Runs pause on approval gates.
- Approval resumes execution.
