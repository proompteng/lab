# Risk-Reward Symmetry & Entry Allowance Cutover (v42)

The v42 release addresses the three primary drivers of negative realized expectancy observed during Nov 16–20 under v41 while preserving the Alpaca sandbox account, monetary limits, and immutable financial evidence:

1. Bounded entry price allowances (`maximumEntryQuoteDriftBps` and `maximumEntryLimitSlippageBps`) enabled symmetrically on equity longs and equity shorts to prevent 0-bps limit-order adverse selection (`10.17 bps` observed drift on unfilled BUYs).
2. Positive modeled risk-reward (`G/L >= 1.0`) net of conservative entry/exit fees and stop slippage before any candidate proposal is funded.
3. Symmetric target-obstruction checking across equity longs and shorts and expected-value-weighted candidate selection (`structuralSupport * G/L - (1 - structuralSupport)`), preventing unpenalized long bounce setups from crowding out higher-reward setups.

## Settle v41

Migration 212 recognizes only the exact clear v41 PAPER identity (parameter `004604dcc48754ff553976d366a4d7643a6a3a1157acac4b89acc879b56c4696`,
protocol `b97dc08473946b82b89f9e4bfae09d18c4bae4ebd8b854f5a6b2b805e35a19c9`). Under advisory and table locks it requires
terminal cycles and intents, flat broker and ledger inventory, settled orders, complete accounting, a fresh exact
reconciliation after every mutation, and no unexpired unresolved inference. It then records the existing
`BLOCKED_STRATEGY_PROTOCOL_CUTOVER` restriction. Native settlement and a later reconciliation create clear OBSERVE.
Other strategy identities and operator holds are unchanged. An empty OBSERVE installation remains a no-op.

Remove the sealed v41 activation request, its identity annotation, and the request/kind/build-lineage inputs in all
three runtime manifests together. Deliver the settlement release through main, immutable cohort publication,
Warehouse/Freight, Kargo and Argo, and verify clear OBSERVE before delivering v42.

## Deliver and activate v42

After settlement, deliver `bayn.jev.protocol.v42` and admission migration `0213_risk_symmetry_admission` (`213_risk_symmetry_admission`) with the mandate absent, verify the immutable v42 image in clear OBSERVE, and then restore the sealed `ResearchCapitalActivationRequest` bound to the verified v42 strategy identity and immutable image digest:

- `symmetricQuestionPolicyHash`: `26fdef322e448b597429bb6ccd0c51d118102128d4d50291f30fc799867ed4bf`
- `strategyBehaviorHash`: `76f0e134e622ada19cb1b087d83da60b54a36d33c86c6c0eee2642ee3fbd3e67`
- `strategyParameterHash`: `c78a10a127b6d4fbfd2fa3d2a433744f02295aa9a2b47b20bacfbd9804ba8ed5`
- `strategyProtocolHash`: `825c8806ba7d16783fcb96fc0d12f49b1e35f03ee81d82f6990bc7b11174d339`
