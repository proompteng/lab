# Supply Chain Attestations

Status: Draft (2026-02-04)

## Problem
Regulated environments require provenance attestations.

## Goals
- Produce build provenance metadata.
- Verify provenance before deployment.

## Non-Goals
- Replacing existing CI pipelines.

## Design
- Adopt SLSA-compatible attestations.
- Expose provenance verification steps.

## Chart Changes
- Document provenance requirements.

## Controller Changes
- None.

## Acceptance Criteria
- Attestations published for each release.
- Documentation covers verification.
