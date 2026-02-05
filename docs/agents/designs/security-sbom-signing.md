# Security: SBOM and Signing

Status: Draft (2026-02-04)

## Problem
Supply chain integrity is required for production adoption.

## Goals
- Publish SBOMs for Jangar images.
- Verify image signatures in CI.

## Non-Goals
- Replacing existing build systems.

## Design
- Generate SBOMs during build.
- Use cosign or equivalent to sign images.

## Chart Changes
- Document image signing and verification.

## Controller Changes
- None.

## Acceptance Criteria
- SBOM artifacts are published per release.
- Signatures are verified in CI.
