# Torghut Design System v1 Index

## Status

- Version: `v1`
- Date: `2026-02-08`
- Source-of-truth implementation status: `implementation-status-matrix-2026-02-21.md`
- Evidence sync: `implementation-audit.md`
- Status: `Planned` (index/meta/snapshot)
- Implementation status (strict): `Implemented=11`, `Partial=44`, `Planned=5` of 60

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Historical note (2026-03-09)

The counts above are a dated v1 corpus snapshot, not a current live implementation dashboard.

For current reading order across the full Torghut design corpus, use:

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md`

## Purpose

This index centralizes the first production-facing design-system corpus (`v1`) for the Torghut stack.
Use it to navigate the full v1 set and to confirm implementation evidence status from
`implementation-status-matrix-2026-02-21.md` and `implementation-audit.md`.

## Entry Points

- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`
- `docs/torghut/design-system/v1/overview.md`

## v1 Document Set

See the full table in `docs/torghut/design-system/README.md` for the complete v1 document index and titles.
