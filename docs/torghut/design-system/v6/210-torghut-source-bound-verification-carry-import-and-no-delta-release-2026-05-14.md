# 210. Torghut Source-Bound Verification Carry Import And No-Delta Release (2026-05-14)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Implemented/partially evolved: Torghut GitOps, migrations, release workflows, and scripts exist; post-deploy verification wiring has changed over time.
- Matched implementation area: CI/CD, release, GitOps, Argo, Knative, and deployment automation.
- Current source evidence:
  - `argocd/applications/torghut/knative-service.yaml`
  - `argocd/applications/torghut/db-migrations-job.yaml`
  - `.github/workflows/torghut-ci.yml`
  - `.github/workflows/torghut-release.yml`
  - `packages/scripts/src/torghut/update-manifests.ts`
- Design drift note: Deployment docs must be checked against current workflows because old names have been retired or replaced.


## Decision

I am selecting a **source-bound verification carry import board with no-delta release accounting** as Torghut's next
profitability contract.

The current revenue surface is specific enough to act. On 2026-05-14 at 16:28Z,
`GET /trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, top queue item
`repair_alpha_readiness`, value gate `routeable_candidate_count`, capital state `zero_notional`, and `max_notional=0`.
The alpha-readiness conveyor selected `H-MICRO-01`, measured routeable candidate count `0 -> 0`, and produced an
active no-delta release key. The no-delta reentry auction denied launch for the right reasons:
`active_no_delta_release_key`, `no_release_condition_changed`, `zero_notional_reentry_ticket_not_selected`,
`jangar_verification_carry_unavailable`, and `duplicate_no_delta_reentry_denied`.

The new fact is that Jangar is no longer completely silent. `GET http://jangar.jangar.svc.cluster.local/ready`
returned a live `jangar.verify-trust-foreclosure-board.v1` board. It blocked `dispatch_repair`, held broad material
actions, and named the stage debt. But Torghut still emitted `verification_carry_import_board=null`, and
`GET /trading/consumer-evidence` also showed no imported carry board. Jangar's repair-slot escrow said why this is not
ready: `selected_receipt_source_revenue_repair_ref_mismatch`, `material_reentry_clearinghouse_missing`, and
`stage_credit_ledger_missing`.

I am choosing to make Torghut the consumer-side authority for this settlement. Torghut should import Jangar's
source-bound exchange only when the exchange is for the same revenue-repair digest, no-delta release key, selected
hypothesis, value gate, selected executable alpha receipt, material reentry receipt, and stage-credit ledger that
Torghut is evaluating. Anything else is not a current carry. It is useful evidence, but it stays a denial reason.

The tradeoff is that Torghut will remain `repair_only` even while Jangar has a live foreclosure board. I accept that.
The active business metric is not board presence. It is routeable candidate recovery without weakening capital safety.
The smallest blocker preventing revenue impact is the missing source-bound import board and the unreconciled repair
slot tuple.

## Runtime Requirements

This contract implements the active cross-swarm runtime requirements:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Value-gate mapping:

- `routeable_candidate_count`: primary value gate; a current import can admit one zero-notional repair slot, and the
  slot must either increase accepted routeable candidates or record no-delta debt.
- `zero_notional_or_stale_evidence_rate`: stale, unavailable, or mismatched Jangar carry increases the denial rate and
  keeps repeat alpha repair closed.
- `fill_tca_or_slippage_quality`: execution TCA repair can win only when the import board says it is the selected
  prerequisite for alpha-readiness release.
- `post_cost_daily_net_pnl`: no paper or live capital opens from this contract; positive post-cost proof remains a
  later gate.
- `capital_gate_safety`: every ticket and import state keeps `max_notional=0` and live submission disabled.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records, trading
flags, GitOps resources, AgentRuns, or market data.

### Cluster And Runtime

- The branch was fast-forwarded to fresh `origin/main` at `c1020e9fd861b5ee122d0ba36d125901863af942`.
- Argo CD showed `torghut` `Synced` and `Healthy` at `c1020e9fd861b5ee122d0ba36d125901863af942`.
- Argo CD showed `jangar` `Synced` and `Healthy` at `a5c72fdb1ac94afd4755fabb9c56f36d9f3cbdda`.
- Argo CD showed `agents` `OutOfSync` and `Healthy` at `df84e741720c98447b4548906040bcdf6a829b6e`.
- Torghut live revision `torghut-00399` and sim revision `torghut-sim-00496` were running with ready pods.
- Torghut options catalog, options enricher, TA, TA sim, WebSocket services, ClickHouse, Keeper, guardrail exporters,
  and the Torghut DB pod were running.
- Recent Torghut events showed revision readiness, successful DB migration completion, completed backfill/bootstrap
  jobs, transient rollout probe failures, and historical failed profit-feedback/autoresearch workflow pods.
- `GET /readyz` returned HTTP `503`, but the degradation was capital-safety aligned: live submission disabled and
  profitability proof floor `repair_only`.

### Database And Data Quality

- `GET /db-check` returned HTTP `200`, `ok=true`, and `schema_current=true`.
- Current and expected Alembic head was `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- `schema_missing_heads=[]`, `schema_unexpected_heads=[]`, `schema_head_delta_count=0`, and
  `schema_graph_lineage_ready=true`.
- The schema witness still reported historical parent forks under `0010_execution_provenance_and_governance_trace`
  and `0015_whitepaper_workflow_tables`.
- Direct DB inspection through `kubectl cnpg psql` was blocked by RBAC on pod exec, so this architecture uses the
  service-owned `/db-check`, `/readyz`, `/trading/revenue-repair`, and `/trading/consumer-evidence` evidence surfaces.
- `/readyz` reported Postgres, ClickHouse, Alpaca, database schema, and static universe OK.
- Data quality blockers were alpha readiness, empirical jobs not ready, stale market-context news, schema-lineage gaps
  in hypothesis evidence, no routeable-candidate movement, and missing source-bound Jangar import.

### Revenue Repair

- `/trading/revenue-repair` generated at `2026-05-14T16:28:24.776278+00:00`.
- `business_state=repair_only` and `revenue_ready=false`.
- Top queue item was `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, priority `70`,
  selected value gate `routeable_candidate_count`, expected unblock value `2`, and required output
  `torghut.executable-alpha-receipts.v1`.
- Blockers were `hypothesis_not_promotion_eligible`, `degraded`, `simple_submit_disabled`, and
  `empirical_jobs_not_ready`.
- `alpha_readiness_settlement_conveyor.status=no_delta`, `settlement_state=no_delta`, selected hypothesis
  `H-MICRO-01`, and selected strategy `microbar_volume_continuation_long_top2_chip_v1@paper`.
- Routeable candidate count was `0 -> 0`; accepted routeable candidate count was `0`.
- Selected no-delta release key was `3381ba65c903086a5f97a1f8`.
- `alpha_repair_dividend_ledger.status=no_delta`, `launch_decision=deny`, and `launch_decision_reason` was
  `no_delta_release_key_active`.
- `no_delta_repair_reentry_auction.reentry_decision=deny`.
- Auction release condition `jangar_verify_foreclosure_ticket_current` was `unavailable`.
- `verification_carry_import_board=null`.

### Consumer Evidence

- `/trading/consumer-evidence` generated at `2026-05-14T16:28:23.243858+00:00`.
- Source-serving repair receipt ledger state was `converged`.
- Serving revision was `torghut-00399`, serving build commit was `df84e741720c98447b4548906040bcdf6a829b6e`, and
  serving image digest was `sha256:ae88bacb3a3e05be7da1f55690476e4e35d059ab6f749370184d1fa333091794`.
- Required and observed contract count were both `6`; missing contracts and schema mismatches were `0`.
- Capital decision remained `repair_only` and max notional remained `0`.
- `verification_carry_import_board=null`.
- Compact no-delta auction reference denied reentry with the same Jangar carry unavailable reason.

### Jangar Carry Evidence

- Jangar `/ready` returned `status=ok`, `business_state=repair_only`, and `revenue_ready=false`.
- `execution_trust.status=degraded` because `jangar-control-plane:verify` was stale.
- `verify_trust_foreclosure_board.schema_version=jangar.verify-trust-foreclosure-board.v1`.
- The board opened foreclosure tickets and denied duplicate alpha repair through the Jangar action decisions.
- Jangar `repair_slot_escrow.status=block`.
- Blocked slot reason codes were `selected_receipt_source_revenue_repair_ref_mismatch`,
  `material_reentry_clearinghouse_missing`, and `stage_credit_ledger_missing`.
- The live board proves Jangar emission exists; it does not prove Torghut imported a current source-bound tuple.

### Source And Test Surface

- Torghut revenue repair digest: `services/torghut/app/trading/revenue_repair.py` (`1180` lines).
- Torghut no-delta auction: `services/torghut/app/trading/no_delta_repair_reentry_auction.py` (`857` lines).
- Torghut alpha-readiness conveyor: `services/torghut/app/trading/alpha_readiness_settlement_conveyor.py`
  (`849` lines).
- Torghut alpha repair dividend ledger: `services/torghut/app/trading/alpha_repair_dividend_ledger.py` (`637` lines).
- Torghut API assembly: `services/torghut/app/main.py` (`7005` lines).
- Jangar foreclosure board source: `services/jangar/src/server/control-plane-verify-trust-foreclosure.ts`
  (`558` lines).
- Jangar ready route: `services/jangar/src/routes/ready.tsx` (`419` lines).
- Existing Torghut tests cover no-delta auction, revenue-repair digest, alpha-readiness conveyor, alpha repair
  dividend ledger, executable alpha repair receipts, consumer evidence, and trading API.
- Missing test family: source-bound verification carry import board, including unavailable, source-ref mismatch,
  release-key mismatch, missing material reentry, missing stage credit, stale import, current import, and one-slot
  admission.

## Problem

Torghut currently sees Jangar verification carry as unavailable even though Jangar emits a live foreclosure board.
That is a consumer-side settlement gap, not just a producer rollout gap.

The concrete failure modes are:

1. A Jangar board can be live but not imported by Torghut.
2. Torghut can deny no-delta reentry with `jangar_verification_carry_unavailable` while the actual Jangar blocker is
   source-ref mismatch.
3. Jangar can report repair-slot blockers that are invisible to Torghut's release-condition accounting.
4. The no-delta release key can change between evidence snapshots, causing duplicate launch denial without explaining
   which side holds the stale key.
5. Data schema can be current while strategy-lineage, empirical, and carry-import evidence remain unfit for capital.
6. Deployer proof can show Torghut and Jangar workloads are healthy without proving the routeable-candidate blocker
   moved.

The system needs a Torghut import board that classifies the Jangar carry state against the exact no-delta tuple.

## Alternatives Considered

### Option A: Treat Jangar Board Presence As Import Success

This option sets Torghut verification carry to current whenever Jangar `/ready` emits a foreclosure board.

Advantages:

- Fastest path to a non-null import.
- Easy to validate manually.
- Confirms that the previous Jangar rollout is visible.

Disadvantages:

- It ignores Jangar's own source-ref mismatch.
- It ignores missing material reentry and stage-credit receipts.
- It can reopen a no-delta repair for a stale release key.
- It would weaken the distinction between serving truth and material repair authority.

Decision: reject.

### Option B: Keep Torghut Local And Ignore Jangar For Zero-Notional Repair

This option lets the no-delta auction select an alpha repair prerequisite even when Jangar carry is unavailable,
because all work remains zero-notional.

Advantages:

- Keeps Torghut moving without waiting for Jangar.
- Could produce routeable-candidate evidence if the next run is lucky.
- Avoids cross-service schema work.

Disadvantages:

- It repeats the exact no-delta failure pattern.
- It increases failed or low-value AgentRun pressure.
- It ignores the active validation contract requiring governing evidence before changes.
- It makes zero-notional a bypass instead of a safety constraint.

Decision: reject.

### Option C: Source-Bound Verification Carry Import Board

This option imports Jangar carry only when it is bound to Torghut's current source tuple and feeds that state into the
no-delta release auction.

Advantages:

- Targets the live blocker directly.
- Makes source-ref mismatch and missing stage receipts first-class denial states.
- Preserves duplicate no-delta denial.
- Gives Jangar and Torghut a common tuple hash for deployer proof.
- Keeps capital safety unchanged.

Disadvantages:

- Adds a cross-service payload and reducer.
- Requires careful TTL handling during fast revenue-repair refreshes.
- Keeps Torghut `repair_only` until both sides agree.

Decision: select Option C.

## Architecture

Torghut emits:

```text
torghut.verification-carry-import-board.v1
  import_board_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  active_no_delta_release_key
  selected_hypothesis_id
  selected_value_gate
  selected_executable_alpha_receipt_id
  imported_jangar_exchange_ref
  imported_jangar_foreclosure_board_ref
  imported_jangar_material_reentry_receipt_id
  imported_jangar_stage_credit_ledger_id
  tuple_hash
  import_state = current | unavailable | source_ref_mismatch | release_key_mismatch |
                 selected_receipt_mismatch | material_reentry_missing | stage_credit_missing |
                 stale | schema_mismatch
  no_delta_release_effect = release_condition_current | hold | block
  admitted_ticket
  reason_codes[]
  validation_commands[]
  rollback_target
```

The no-delta auction consumes the import board as one release condition:

```text
release_condition
  code = jangar_source_bound_verification_carry_current
  state = current | unavailable | mismatch | stale | blocked
  tuple_hash
  reason_codes[]
```

Release rules:

1. `import_state=current` is required before any Jangar-carry release condition can open.
2. Current means Jangar exchange and Torghut revenue-repair share source ref, release key, selected hypothesis, value
   gate, selected receipt, material reentry receipt, stage-credit ledger, and TTL.
3. `source_ref_mismatch`, `release_key_mismatch`, `material_reentry_missing`, and `stage_credit_missing` keep
   `reentry_decision=deny`.
4. A current import can admit only one zero-notional repair ticket.
5. A selected ticket must settle with routeable-candidate movement or a no-delta receipt against the same tuple hash.
6. Paper and live capital remain blocked until proof floor, routeability, post-cost expectancy, and live submission
   gates pass in a later contract.

## Implementation Scope

Engineer milestone:

- Add `verification_carry_import_board` builder in Torghut trading code.
- Import Jangar's source-bound exchange from the configured Jangar evidence surface.
- Feed the import board into `build_revenue_repair_digest`.
- Add compact import reference to `/trading/consumer-evidence`.
- Update no-delta auction to use `jangar_source_bound_verification_carry_current` instead of the generic unavailable
  state.
- Preserve existing generic `jangar_verification_carry_unavailable` fallback when the exchange is absent or invalid.
- Add regression tests for every import state and no-delta release effect.

Deployer milestone:

- Prove Jangar live exchange is present and fresh.
- Prove Torghut import board is present and fresh.
- Prove both sides expose the same tuple hash.
- Prove source-ref mismatch and missing material/stage receipts deny reentry.
- Prove no paper or live capital gate changes.

## Validation Gates

Local validation:

```bash
uv run --frozen pytest services/torghut/tests/test_no_delta_repair_reentry_auction.py
uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k revenue_repair
uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

Live read-only validation:

```bash
curl -fsS http://jangar.jangar.svc.cluster.local/ready | jq '.source_bound_verification_carry_exchange'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.verification_carry_import_board'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.no_delta_repair_reentry_auction.release_conditions'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.verification_carry_import_board'
```

Acceptance:

- Import board is non-null.
- Import board carries a tuple hash and exact mismatch state.
- No-delta auction no longer collapses live Jangar board presence into generic unavailable carry.
- `routeable_candidate_count` remains the selected value gate.
- Capital remains zero-notional and live submission remains disabled.

## Rollout

1. Ship import board in observe mode.
2. Emit import state without changing no-delta auction decisions.
3. Add no-delta auction release condition using the import state.
4. Keep fallback unavailable behavior for invalid or absent Jangar exchange.
5. After both endpoints show the same tuple hash, allow one zero-notional selected ticket.
6. Keep paper and live capital closed.

## Rollback

- Disable import board emission and fall back to `jangar_verification_carry_unavailable`.
- Ignore Jangar source-bound exchange if schema version mismatches.
- Keep active no-delta release keys and duplicate launch denial.
- Keep `max_notional=0` and live submission disabled.
- Revert to doc 209 behavior if tuple matching causes endpoint compatibility issues.

## Risks

- Fast revenue-repair refreshes can make tuple matching look flaky. Mitigation: short TTL, explicit stale state, and
  tuple hash in both endpoints.
- Jangar may emit a board without material reentry or stage-credit receipts. Mitigation: Torghut classifies these as
  import states, not current carry.
- A current import can still produce no routeable-candidate movement. Mitigation: one-ticket limit and no-delta debt
  settlement against the tuple.
- Direct database access may remain blocked in agent pods. Mitigation: use service-owned DB witnesses and record RBAC
  denial in handoff evidence.

## Handoff

Engineer next action: implement `torghut.verification-carry-import-board.v1` and the matching no-delta auction release
condition. The governing design for any code change is this document plus the Jangar companion contract.

Deployer next action: after rollout, prove the Jangar exchange and Torghut import board share the same tuple hash. Do
not claim revenue impact until `routeable_candidate_count` moves above zero or the handoff names the exact tuple state
blocking movement.
