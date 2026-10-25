# Torghut Versioned Economic Policy And Parity Contract

Status: Slice 12 implementation contract. Production completion still requires the merge, image, GitOps, and runtime
evidence described below.

Roadmap: [Slice 12 - Define One Versioned Economic Policy](implementation-roadmap.md#slice-12---define-one-versioned-economic-policy).

## Decision

Replay, shadow, and paper execution must load the same immutable economic-policy artifact and must pass the same
controlled decision through the production `ExecutionPolicy`. A stage may add evidence or become more restrictive, but
it may not silently replace session, sizing, fee, borrow, latency, slippage, stale-data, risk, or accounting semantics.

The implementation deliberately adds no service, controller, scheduler, database table, or policy registry. It uses:

- one strict JSON artifact at `services/torghut/config/economic-policy-v1.json`;
- one typed loader at `services/torghut/app/trading/economic_policy.py`;
- the existing production `ExecutionPolicy` as the pre-broker decision path;
- one controlled fixture whose result is compared across separately loaded stage configurations.

This policy is a consistency and fail-closed control. It does not prove that a strategy is profitable and it grants no
capital authority.

## Artifact Identity

The v1 artifact uses schema `torghut.economic-policy.v1`, policy ID `alpaca-us-equity-v1`, and effective date
`2026-07-01`. Its canonical digest is:

`sha256:071068019c37c8f6e7d379529e6506661429d88bb082e876bfca2df221bc4d65`

The digest is SHA-256 over the Pydantic-validated JSON payload serialized with sorted keys and compact separators.
Whitespace and input key order therefore do not affect identity. Missing fields, extra fields, invalid bounds, an
unknown schema, or a digest mismatch fail closed.

The image contains the artifact at `/app/config/economic-policy-v1.json`. GitOps must set both
`TRADING_ECONOMIC_POLICY_PATH` and `TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST`; configuring only one is invalid. The
critical-path scheduler refuses to construct its execution policy when the artifact is absent, its digest differs, or
legacy runtime settings contradict its projection.

## Normative Semantics

| Domain | v1 contract | Enforcement boundary |
| --- | --- | --- |
| Venue | Alpaca US equities | Artifact schema and broker-specific execution path |
| Session | XNYS, America/New_York, regular hours only | Artifact validation plus existing session and cutoff gates |
| Sizing | 50% per order, 50% per symbol, 100% gross, 50% net | Replay settings binding, scheduler settings projection, and simple/portfolio risk gates |
| Participation | Maximum 10% of observed ADV | Production execution cost and participation gate |
| Order preference | Prefer a near-touch limit when policy rules permit | Production `ExecutionPolicy` |
| Fees | Commission, SEC, TAF, and CAT schedule | Shared transaction-cost model and fee fallback reconstruction |
| Borrow | Easy-to-borrow only; reject hard-to-borrow or unknown status | Existing broker asset preflight; artifact permits no weaker behavior |
| Latency | 60-second assumed execution; 250 ms advisor timeout | Cost-impact inputs and runtime settings projection |
| Slippage | Half-spread, volatility drift, and nonlinear participation impact | Shared transaction-cost model |
| Stale data | Reject missing data; 60-second stored-quote age, zero future-quote lookahead, 20-second broker-fallback age | Quote, signal-continuity, and market-context runtime gates |
| Risk | 1% daily stop, 5% persistent drawdown stop, intraday flat | Scheduler capital controls and session closeout gates |
| Accounting | USD Decimal arithmetic, average cost, net of modeled costs | Replay/economic-ledger semantics; broker facts remain externally authoritative |

The economic policy is the maximum envelope. Strategy-specific limits may be lower. Enabled strategy configuration
may not declare a gross envelope above the global cap, and the runtime risk gates retain the global cap independently.

## Fee Model Boundary

The v1 fee schedule follows the Alpaca brokerage fee schedule revised July 1, 2026, the SEC fiscal-year 2026 fee-rate
advisory, and the applicable FINRA fee schedule:

- [Alpaca Brokerage Fee Schedule](https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf)
- [SEC Fee Rate Advisory 2026-2](https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2)
- [FINRA Fee Adjustment Schedule](https://www.finra.org/rules-guidance/rule-filings/sr-finra-2024-019/fee-adjustment-schedule)

SEC and TAF fees apply to sales; CAT fees apply to buys and sells. The broker aggregates fee types at the account/day
boundary before rounding. Torghut does not yet have that complete future-day set at order-evaluation time, so the
pre-trade estimator rounds each fee type up per order. This is intentionally conservative and must be labeled
`per_order_fee_type_conservative`; it must never be presented as exact broker settlement. Actual broker activities and
reconciliation replace modeled fees when available.

All legacy and current Alpaca schedule-fallback cost bases are non-promotion-grade. They can support order selection,
stress tests, and diagnostics, but a runtime bucket containing them remains blocked from profitability promotion until
broker-reported or independently reconciled fees replace the estimates.

The policy centralizes the fallback schedule used by execution TCA and runtime-window reconstruction. Keeping a second
copy of rates or effective dates is forbidden because it creates silent research/runtime drift.

## Stage Wiring

| Stage | Policy source | Execution path | Evidence produced |
| --- | --- | --- | --- |
| Replay | Explicit `--economic-policy` path, defaulting to the committed artifact | Replay decision engine then production `ExecutionPolicy` | Policy digest and pre-broker intent digest in replay output and exact ledger |
| Shadow | Scheduler Deployment path and expected digest from GitOps | Production scheduler `ExecutionPolicy`, with broker mutation still blocked | Direct scheduler status plus controlled fixture output |
| Paper | Simulation Knative Service path and expected digest from GitOps | Production `ExecutionPolicy` fixture without broker I/O | Controlled fixture output from the promoted image |

Replay temporarily binds the artifact projection into legacy global settings because strategy and risk readers still
consume the existing `Settings` object. The binding is explicit, scoped to one replay, restored in `finally`, and has
regression coverage. It replaces the prior production use of `unittest.mock.patch`. Removing the remaining global
settings dependency belongs to the execution-envelope work in Slice 14; a second configuration authority must not be
introduced meanwhile.

The zero-second forward-quote contract removes a legacy target-plan catch-up override. That route no longer exists,
and allowing a quote timestamp after the signal in replay or live-submit configuration would create lookahead drift.

## Proof That Can Fail

The fixture is an AAPL sell decision with a fixed event time, quote, quantity, ADV, spread, and volatility. Each stage
must independently emit:

- `approved=true`;
- the same economic-policy digest;
- the same pre-broker intent digest.

The parity function rejects missing or unexpected stages. Tests deliberately change the paper policy and require both
the policy digest and intent digest comparison to fail. The API status reports only its local artifact and local fixture
result; it does not self-assert cross-stage parity.

Local replay evidence:

```bash
cd services/torghut
uv run --frozen python scripts/verify_economic_policy_parity.py \
  --stage replay \
  --policy config/economic-policy-v1.json \
  --expected-digest sha256:071068019c37c8f6e7d379529e6506661429d88bb082e876bfca2df221bc4d65
```

After image promotion, run the same script from the actual scheduler container with `--stage shadow` and from the
active `torghut-sim` revision with `--stage paper`, using their environment-provided path and digest. Compare parsed
JSON fields rather than logs. A label repeated three times in one process is not evidence.

Production proof also requires:

1. required CI succeeds on the merged revision;
2. the promoted image identity contains the policy artifact and verifier;
3. Argo is Synced/Healthy at that revision;
4. the scheduler remains a singleton and loads the expected digest;
5. replay, shadow, and paper fixture outputs match exactly;
6. direct scheduler status reports the local policy valid with no runtime mismatches;
7. broker mutation and capital-authority readback remain blocked throughout this slice.

## Rollback

For the first version, rollback is a Git revert of the code and all three GitOps pins while risk-increasing capital
remains disabled. Do not edit a live Deployment or policy file in place. After more than one policy version exists,
retain prior immutable artifact files and roll back by pinning the previous image/path/digest tuple through GitOps.

Rollback succeeds only when the scheduler loads the intended prior digest, all stage fixture outputs agree again, and
the capital gate remains closed. Reintroducing stage-specific CLI flags, zero-fee replay defaults, test mocks, or the
former 4x production gross cap is not an acceptable rollback.

## Remaining Boundaries

Slice 12 removes known policy drift; it does not finish profitability proof. The following remain separate required
work:

- Slice 13: immutable point-in-time market and feature receipts;
- Slice 14: one complete execution-envelope digest and differential conformance;
- Slice 15: registered trials and independent reproduction;
- Slice 16: selection-adjusted candidate governance;
- Slices 17-20: calibrated execution/portfolio proof, paper probation, and reconciled micro-live capital grants.

No paper or live stage may cite this artifact alone as evidence of positive expected return.
