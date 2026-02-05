# Multi-Namespace Controller Guardrails

Status: Draft (2026-02-04)

## Problem
Misconfigured namespaces can lead to missed resources or RBAC errors.

## Goals
- Validate namespace scopes at startup.
- Provide clear errors for missing RBAC.

## Non-Goals
- Automatic RBAC escalation.

## Design
- Check namespace list and RBAC at startup.
- Refuse to start on invalid config.

## Chart Changes
- Add validations in values.schema.json.

## Controller Changes
- Add startup checks for namespace permissions.

## Acceptance Criteria
- Misconfigurations are reported before reconcile.
- Controllers start only with valid scopes.
