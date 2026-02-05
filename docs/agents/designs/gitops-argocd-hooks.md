# GitOps and Argo CD Hooks

Status: Draft (2026-02-04)

## Problem
GitOps deployments need deterministic pre/post-sync behavior.

## Goals
- Provide optional Argo CD hooks for smoke testing.
- Clean up smoke resources safely.

## Non-Goals
- Embedding GitOps controllers in the chart.

## Design
- Add optional PreSync and PostSync Jobs.
- Allow hook enablement via values.

## Chart Changes
- Add hook templates and values.
- Document Argo CD usage.

## Controller Changes
- None.

## Acceptance Criteria
- Hooks run successfully when enabled.
- No hooks are created when disabled.
