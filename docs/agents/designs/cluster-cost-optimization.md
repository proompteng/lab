# Cluster Cost Optimization

Status: Draft (2026-02-04)

## Problem
High throughput can lead to wasted compute costs.

## Goals
- Optimize resource requests and scaling defaults.
- Provide guidance on cost controls.

## Non-Goals
- Full cost management system.

## Design
- Document resource sizing profiles.
- Expose autoscaling and right-sizing controls.

## Chart Changes
- Add sizing profiles in values and README.

## Controller Changes
- Expose metrics for resource utilization.

## Acceptance Criteria
- Operators can select sizing profiles.
- Cost guidance is documented.
