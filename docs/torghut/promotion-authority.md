# Torghut Promotion Authority

Torghut uses one production authority model for strategy target promotion:
`app.trading.promotion_authority.PromotionAuthority`.

The model separates data collection from capital authorization. A strategy can be
eligible for source collection or paper probation without being eligible to route
capital. Live capital submission must read `capital_promotion_allowed`, not an OR
of legacy compatibility booleans.

## Stages

- `source_collection`: the target is allowed to collect source/runtime evidence.
- `paper_probation`: the target has paper-probation authority but no capital
  authority.
- `capital_blocked`: the target is blocked from capital routing and must carry
  blockers.
- `capital_allowed`: the target is allowed to route capital. This is the only
  stage where `capital_promotion_allowed=true`.

## Runtime Contract

Writers must build authority fields through one of these constructors:

- `source_collection_authority(...)`
- `paper_probation_authority(...)`
- `capital_blocked_authority(...)`
- `capital_allowed_authority()`

Consumers that decide whether capital can route must use
`target_capital_promotion_allowed(target)`.

`promotion_allowed`, `final_promotion_allowed`, and
`final_promotion_authorized` remain projected only for compatibility with older
payloads and reports. New production checks must not combine those legacy fields.

## Operational Meaning

When Torghut is collecting strategy data, the expected state is usually
`source_collection` or `paper_probation`. That is not a trading failure. It means
the system is collecting evidence without routing capital.

When Torghut is expected to trade, readiness evidence must show
`promotion_stage=capital_allowed`, `capital_promotion_allowed=true`, and no
`promotion_blockers`.
