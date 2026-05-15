# Consumer-Evidence Contract Canary Rollout (2026-05-15)

## Design provenance

- Torghut: `docs/torghut/design-system/v6/213-torghut-consumer-evidence-contract-canary-and-alpha-reentry-transport-2026-05-15.md`
- Jangar: `docs/agents/designs/207-jangar-consumer-evidence-transport-split-and-source-serving-contract-canary-2026-05-15.md`

## Runtime requirement

Live `/trading/revenue-repair` selected `repair_alpha_readiness` as the top queue item with
`value_gate=routeable_candidate_count`, `required_output_receipt=torghut.executable-alpha-receipts.v1`,
`business_state=repair_only`, `revenue_ready=false`, and `max_notional=0`.

Before and after this local implementation run, the live business evidence remained:

| field                                | before                      | after                       |
| ------------------------------------ | --------------------------- | --------------------------- |
| `business_state`                     | `repair_only`               | `repair_only`               |
| `revenue_ready`                      | `false`                     | `false`                     |
| top queue item                       | `repair_alpha_readiness`    | `repair_alpha_readiness`    |
| affected value gate                  | `routeable_candidate_count` | `routeable_candidate_count` |
| `accepted_routeable_candidate_count` | `0`                         | `0`                         |
| `max_notional`                       | `0`                         | `0`                         |

The expected first movement is retiring false source-serving transport debt, not creating positive notional or live
submission.

## Change

- Torghut summary consumer evidence now carries `torghut.consumer-evidence-contract-canary.v1` refs for
  `route_warrant_exchange` and `repair_bid_settlement_ledger`.
- Full Torghut consumer evidence remains the authority for the complete route-warrant and repair-bid bodies.
- Jangar consumes compact refs first, falls back to one bounded full fetch when refs are missing, and records
  `torghut_contract_transport_unavailable` when that fallback fails instead of reporting false missing contracts.
- Source-serving verdicts can infer required contracts from compact route-warrant and repair-bid refs while keeping
  zero-notional repair-only behavior.

## Validation

- `uv sync --frozen --extra dev`
- `uv run --frozen ruff check app/main.py app/trading/consumer_evidence.py tests/test_consumer_evidence.py tests/test_trading_api.py`
- `uv run --frozen ruff format --check app/main.py app/trading/consumer_evidence.py tests/test_consumer_evidence.py tests/test_trading_api.py`
- `uv run --frozen pytest tests/test_consumer_evidence.py`
- `uv run --frozen pytest tests/test_trading_api.py -k consumer_evidence`
- `uv run --frozen pytest tests/test_no_delta_repair_reentry_auction.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `bunx oxfmt --check services/jangar/src/routes/ready.test.ts services/jangar/src/server/control-plane-torghut-consumer-evidence.ts services/jangar/src/server/control-plane-source-serving-contract-verdict.ts services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts services/jangar/src/server/__tests__/control-plane-source-serving-contract-verdict.test.ts`
- `bunx oxlint --config .oxlintrc.json services/jangar/src/routes/ready.test.ts services/jangar/src/server/control-plane-torghut-consumer-evidence.ts services/jangar/src/server/control-plane-source-serving-contract-verdict.ts services/jangar/src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts services/jangar/src/server/__tests__/control-plane-source-serving-contract-verdict.test.ts`
- `bun run --filter @proompteng/jangar tsc`
- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-source-serving-contract-verdict.test.ts`
- `bun run --filter @proompteng/jangar test`

## Rollback

Revert the implementation PR or have Jangar ignore `contract_canary_refs` and return to full payload authority. The
Torghut summary canary is additive, the full consumer-evidence payload remains unchanged as the contract-body source,
and all affected repair evidence keeps `max_notional=0`.

## Risk

The main risk is ref/body drift between summary and full payloads. The mitigation is to compare schema versions, ids,
fresh-until values, and max-notional in Jangar full-fetch validation and post-deploy checks before using the refs for
anything beyond repair-only source-serving evidence.
