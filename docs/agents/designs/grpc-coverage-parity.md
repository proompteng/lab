# gRPC Coverage Parity for agentctl

Status: Draft (2026-02-04)

## Problem
gRPC endpoints lag behind REST and CLI features.

## Goals
- Ensure gRPC supports all CLI operations.
- Maintain compatibility with REST.

## Non-Goals
- Breaking changes to existing gRPC clients.

## Design
- Add missing gRPC methods and fields.
- Update agentctl to use new fields.

## Chart Changes
- Document gRPC enablement and tokens.

## Controller Changes
- Implement missing gRPC handlers.

## Acceptance Criteria
- agentctl supports list/filter parity via gRPC.
- gRPC schema matches REST capabilities.
