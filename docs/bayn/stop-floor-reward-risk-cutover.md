# Stop-Floor & Reward-Risk Cutover (v43)

The v43 release (admission identity: parameter `810fedc00003ee940f3af6982ce65357662e241ec8c43b7d89922f6766108774`,
protocol `f9eaf3c7258e7f9bb5c4f070cfbde7d119cd6cd43f1272653f713bea680da17e`) tightens candidate funding on top of v42 while preserving the Alpaca sandbox account, monetary limits, and immutable financial evidence:

1. Enforce a minimum `15 bps` chart-referenced protective stop distance (`stop >= 15 bps` below spot bid for longs and `stop >= 15 bps` above spot ask for shorts) before admitting source candidates or funding entry proposals, eliminating the sub-`15 bps` stop-noise bucket (`-$504.35` across `163` historical fills).
2. Require modeled reward-to-risk `G/L >= 1.20` (`modeledGain * 5 >= modeledLoss * 6`) net of conservative entry/exit fees and stop slippage before any candidate proposal is funded.

## Settle v42

Migration 216 recognizes only the exact clear v42 PAPER identity (parameter `c78a10a127b6d4fbfd2fa3d2a433744f02295aa9a2b47b20bacfbd9804ba8ed5`,
protocol `825c8806ba7d16783fcb96fc0d12f49b1e35f03ee81d82f6990bc7b11174d339`). Under advisory and table locks it requires
terminal cycles and intents, flat broker and ledger inventory, settled orders, complete accounting, a fresh exact
reconciliation after every mutation, and no unexpired unresolved inference. It then records the existing
`BLOCKED_STRATEGY_PROTOCOL_CUTOVER` restriction. Native settlement and a later reconciliation create clear OBSERVE.
Other strategy identities and operator holds are unchanged. An empty OBSERVE installation remains a no-op.

Remove the sealed v42 activation request, its identity annotation, and the request/kind/build-lineage inputs in all
three runtime manifests together. Deliver the settlement release through main, immutable cohort publication,
Warehouse/Freight, Kargo and Argo, and verify clear OBSERVE before delivering v43.

## Deliver and activate v43

After settlement, deliver `bayn.jev.protocol.v43` and admission migration 217 with the mandate absent, verify the
immutable v43 image in clear OBSERVE, and then restore the sealed `ResearchCapitalActivationRequest` bound to the
verified v43 strategy identity and immutable image digest.
