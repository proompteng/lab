# Namespaced vs Cluster-Scoped Install Matrix

Status: Draft (2026-02-04)

## Problem
Multi-tenant clusters need clear RBAC and scope guarantees.

## Goals
- Support strict namespaced installs by default.
- Document when cluster-scoped RBAC is required.

## Non-Goals
- Global reconciliation without explicit opt-in.

## Design
- Make rbac.clusterScoped explicit and required for multi-namespace.
- Add validation to prevent misconfiguration.

## Chart Changes
- Validate controller.namespaces and rbac.clusterScoped.
- Document scope matrix.

## Controller Changes
- Fail fast on namespace wildcard without cluster RBAC.

## Acceptance Criteria
- Namespaced install works without cluster permissions.
- Misconfigured installs surface clear errors.
