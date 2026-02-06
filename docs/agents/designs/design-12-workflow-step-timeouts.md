# Workflow Step Timeouts and Retries

Status: Draft (2026-02-04)

## Problem
Long-running steps can block workflows without clear timeout handling.

## Goals
- Add per-step timeout configuration.
- Standardize retry behavior.

## Non-Goals
- Implementing a new workflow engine.

## Design
- Add timeout fields to workflow step spec.
- Enforce timeout in controller and mark step failed.

## Chart Changes
- Update CRD schema and examples.

## Controller Changes
- Track step start times and enforce deadlines.

## Acceptance Criteria
- Steps time out deterministically.
- Retries respect backoff settings.
