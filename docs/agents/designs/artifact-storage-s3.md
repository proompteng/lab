# Artifact Storage Integration

Status: Draft (2026-02-04)

## Problem
Artifacts need durable storage at scale.

## Goals
- Provide S3-compatible artifact storage support.
- Expose credentials via secrets.

## Non-Goals
- Bundling object storage in the chart.

## Design
- Add artifact storage config and secret refs.
- Ensure agent-runner writes artifacts to storage.

## Chart Changes
- Expose artifact storage values and schema.

## Controller Changes
- Pass artifact config to jobs via env.

## Acceptance Criteria
- Artifacts persist outside the cluster.
- Credentials are secret-based.
