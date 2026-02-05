# API Pagination and Watch Behavior

Status: Draft (2026-02-04)

## Problem
Large lists can overload the API and clients.

## Goals
- Provide pagination for list endpoints.
- Support watch streams for incremental updates.

## Non-Goals
- Full query language.

## Design
- Add limit and continue token parameters.
- Expose watch streams with resource version.

## Chart Changes
- Document API pagination behavior.

## Controller Changes
- Implement pagination and watch options.

## Acceptance Criteria
- Large lists return paginated results.
- Watch streams deliver incremental updates.
