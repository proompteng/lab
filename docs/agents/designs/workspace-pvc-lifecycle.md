# Workspace PVC Lifecycle

Status: Draft (2026-02-04)

## Problem
Workspaces can leak storage without cleanup policies.

## Goals
- Provision PVCs for workspaces on demand.
- Auto-cleanup after retention.

## Non-Goals
- Persistent workspace snapshots.

## Design
- Support workspace size and storage class values.
- Implement cleanup on workspace deletion.

## Chart Changes
- Expose workspace defaults in values.

## Controller Changes
- Create and delete PVCs in supporting controller.

## Acceptance Criteria
- PVCs created for workspace resources.
- PVCs deleted after workspace cleanup.
