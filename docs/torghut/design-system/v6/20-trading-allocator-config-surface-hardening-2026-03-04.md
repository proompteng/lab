# 20: Trading Allocator Config Surface Hardening (2026-03-04)

## Problem

Torghut allocator configuration in `services/torghut/app/config.py` had two partially overlapping env-mapping surfaces:
- `TRADING_ALLOCATOR_CORRELATION_SYMBOL_GROUPS` vs `TRADING_ALLOCATOR_SYMBOL_CORRELATION_GROUPS`
- `TRADING_ALLOCATOR_CORRELATION_GROUP_NOTIONAL_CAPS` vs `TRADING_ALLOCATOR_CORRELATION_GROUP_CAPS`

This duplication caused inconsistent normalization/validation paths and duplicated merge logic in `portfolio.py`, increasing the chance of runtime drift, hidden misconfiguration, and rollout instability when one key family is used while another is silently ignored.

## Decision

Adopt one canonical allocator config surface while keeping backward-compatible env aliases.

- Canonical settings fields:
  - `trading_allocator_symbol_correlation_groups`
  - `trading_allocator_correlation_group_caps`
- Validation aliases retained for legacy keys:
  - `TRADING_ALLOCATOR_CORRELATION_SYMBOL_GROUPS` → `trading_allocator_symbol_correlation_groups`
  - `TRADING_ALLOCATOR_CORRELATION_GROUP_NOTIONAL_CAPS` → `trading_allocator_correlation_group_caps`
- Canonical output maps are normalized once and reused by runtime allocation logic.
- Remove duplicated merge behavior in allocator construction so one map is the source of truth.

## Alternatives Considered

1. Keep the duplicated fields as-is
  - Pros: zero migration cost and no test churn.
  - Cons: continues dual-parser ambiguity, repeated normalization paths, and risk of misaligned aliases during rollout.

2. Drop legacy alias support immediately
  - Pros: cleanest schema with one-time change.
  - Cons: high blast radius; live runtimes and existing runbooks that still emit legacy keys would fail fast.

3. Canonicalize with alias compatibility (selected)
  - Pros: reduces future config drift, preserves existing deployments, and makes a single allocator path enforceable.
  - Cons: requires one-time code+test update and explicit upgrade note in release docs.

## Implementation

1. `services/torghut/app/config.py`
  - Removed duplicated allocator field declarations.
  - `trading_allocator_symbol_correlation_groups` now has canonical alias and `AliasChoices` for legacy key support.
  - `trading_allocator_correlation_group_caps` now has canonical alias and `AliasChoices` for legacy key support.
  - Normalization functions now target canonical fields and enforce one non-duplicated post-processing path.
2. `services/torghut/app/trading/portfolio.py`
  - Uses canonical allocator maps directly in `allocator_from_settings` and removes merge logic.
3. `services/torghut/tests/test_config.py`
  - Updated map assertions to canonical settings names.
  - Added explicit compatibility test for legacy aliases.

## Verification Matrix

- `services/torghut/tests/test_config.py::TestSettings::test_allocator_budget_maps_are_normalized`
  - validates normalization and canonical field mapping.
- `services/torghut/tests/test_config.py::TestSettings::test_legacy_allocator_aliases_are_supported`
  - validates compatibility for legacy alias values.

## Risk and Rollback

- Risk: if a deployment depends on both alias families in different services, only merge-time precedence applies via environment resolution order; behavior remains explicit and backward-compatible.
- Rollback: revert this PR and redeploy the previous image if unexpected alias behavior is observed.

## Relation to Objective

This change improves source reliability and maintainability while reducing rollout risk from mixed-config behavior. It is aligned with the torghut-quant discover objective of a single production-safe design change plus explicit tradeoff documentation.
