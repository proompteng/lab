# Native equity short cutover

The v41 release adds bearish setups to the existing JeV chart and judgment pipeline and changes its equity entry
selection to liquid S&P 100 stocks. Broker account permission already existed; v40 remains a long-only strategy.
The account stays in the Alpaca sandbox. Preserve monetary limits, grant class, credentials and all financial evidence.

## Settle v40

Migration 199 recognizes only the exact clear v40 PAPER identity (parameter `6b47647a539b3a35971cfbc596c0a431300cababddea3d50ea460b4308a671bb`,
protocol `140d646d825c1f77d3c5e1f21c425680f64d99226d2c2aacca97f70b11675dcf`). Under advisory and table locks it requires
terminal cycles and intents, flat broker and ledger inventory, settled orders, complete accounting, a fresh exact
reconciliation after every mutation, and no unexpired unresolved inference. It then records the existing
`BLOCKED_STRATEGY_PROTOCOL_CUTOVER` restriction. Native settlement and a later reconciliation create clear OBSERVE.
Other strategy identities and operator holds are unchanged. An empty OBSERVE installation remains a no-op.

Remove the sealed v40 activation request, its identity annotation, and the request/kind/build-lineage inputs in all
three runtime manifests together. Retain the validated request privately before removal. Configuration removal alone
does not change durable authority. Deliver the settlement release through main, immutable cohort publication,
Warehouse/Freight, Kargo and Argo. Verify the deployed revision, clear OBSERVE, fresh exact reconciliation, zero open
positions/orders/unresolved mutations, and unchanged financial history before delivering the successor protocol.

## Deliver and activate v41

After that boundary, deliver the native short implementation and matching source/strategy bindings with the mandate
absent. The admission migration requires clear OBSERVE again. Preserve the existing one-position, 20% gross allocation,
15-minute holding limit, spread/freshness checks, reconciliation, loss and turnover controls. Opening stock shorts need
fresh account/configuration/asset eligibility, whole shares, regular hours, a broker bracket and 150% collateral. Covers
use BUY and the ask. The source retains old consumers' streams within the 30-subscription limit and adds independently
identified, completed REST bars; no partial or fabricated candle can authorize an entry.

Prepare a reviewed mandate through existing constructors only after the successor's immutable image is verified.
Bind the same broker identity and grant/monetary limits to the new strategy and actual authored build; account for the
reviewed symbol selection when computing the risk policy hash. Restore its sealed request, matching annotation and
three runtime activation inputs as one change. Native activation owns the PAPER transition. Kargo promotion never
grants live capital. Verify the resulting protocol, source, candidate set, authority, reconciliation, ledger and
controller progress. A closed stock market cannot establish a fresh regular-session fill.

Before the successor admission migration, a compatible v40 image can recover through the established settlement path.
After admission, never restore a retired v40 mandate by itself. Recover the successor through its native authority and
Kargo lineage. Liquidity, image health and successful fills do not establish positive all-in expected returns.
