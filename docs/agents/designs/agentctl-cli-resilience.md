# agentctl CLI Resilience

Status: Draft (2026-02-04)

## Problem
CLI failures reduce operator trust and automation reliability.

## Goals
- Improve CLI error messages and retries.
- Support offline diagnostics.

## Non-Goals
- Replacing the CLI with a UI.

## Design
- Add structured error output and retry options.
- Provide diagnose subcommand enhancements.

## Chart Changes
- Document CLI settings in README.

## Controller Changes
- Expose detailed status for CLI consumption.

## Acceptance Criteria
- CLI failures include actionable guidance.
- Diagnose output includes controller health.
