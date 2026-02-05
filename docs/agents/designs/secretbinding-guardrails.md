# SecretBinding Guardrails

Status: Draft (2026-02-04)

## Problem
Runs can mount secrets without clear governance.

## Goals
- Enforce secret allowlists and bindings.
- Surface violations in status.

## Non-Goals
- Secret rotation automation.

## Design
- Use SecretBinding CRDs to govern which secrets may be used.
- Validate bindings before job creation.

## Chart Changes
- Add examples for SecretBinding usage.

## Controller Changes
- Check SecretBinding before mounting secrets.

## Acceptance Criteria
- Unauthorized secrets are rejected.
- Authorized secrets are allowed.
