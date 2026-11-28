# v2 PAPER activation review basis — 2026-11-26

This request resumes prospective measurement on the existing Alpaca sandbox account after the settled v1-to-v2 OBSERVE cutover. It binds the reviewed v2 strategy and existing v6 PAPER risk policy. The historical audit and incomplete replay do not establish profitability.

## Verified authored release

- Source: `8c11dd123c71a9a428603a4be35685bbeda4bc29`.
- Successful immutable publication: [run 45796638331](https://github.com/proompteng/lab/actions/runs/45796638331).
- Bayn image: `registry.ide-newton.ts.net/lab/bayn@sha256:8cabfa86b3462e7515b63734689d2abc3d26f5ffb3f431c7b78d9dda6abb33f1`.
- Research image: `sha256:9ce7e768d7b790a7ea879f5a702ac28090e091d37990e04a42d5fbc9decce4d0`.
- Broker-feed image: `sha256:d851296551f64e8711a34fcee1b5185780b1d36fc7f3d8bfce6cfa88eb60653b`.
- Cohort artifact `15107356563` ZIP SHA-256: `c36fe61cbd350b3efc4e7ae1292e03af046798f2778b7cea4482fd00e5c391ae`, matching GitHub's artifact digest.
- Freight: `16843828fab0cff05a270c7d437baa47b9b31a26`; promotion `bayn.01m8bph3tnx4f12xspg95evr3f.1684382` succeeded.
- Generated GitOps revision: `8d75a37b4a7699b1ca679ecf08c5cf8bb403c0fa`.
- Argo synchronization and the native `bayn-execution-activate-8c11dd123c71` hook succeeded. Both status replicas reported the exact embedded source and digest; the selected status, controller, research and broker-feed workloads were ready.

## Settled account boundary

Primary database proof at 2026-11-26 10:41:28 UTC showed the same retained Alpaca sandbox account, durable maximum/effective OBSERVE, kill CLEAR, no restriction reason, and fresh EXACT reconciliation with zero discrepancies at 10:41:25.280 UTC. Latest open orders, nonflat ledger symbols, unfinished cycles and unresolved mutations were all zero. The 3,041 canonical fills each retained accounting and posting receipts; the latest fill remained November 25 at 20:59:51.988404 UTC.

Clear OBSERVE generation `d6c032f04aa9799410ac9040da171fb48476cd9a2328732d0d104cd239b9d34f` was established at 10:38:31.978931 UTC. Runtime proof at 10:44:53.371 UTC reported READY, native epoch 497, naturally advanced sequence 424281, SUCCESS / WINDOW_CLOSED, capital activation NotConfigured, and zero positions, open orders and exposure. Cash and equity were both $93,038.64.

A guarded read-only export rechecked the same account, this clear OBSERVE generation, fresh exact reconciliation, zero positions and no unfinished intents before preparing the private account identifier. No account value or broker credential is retained in this document.

## Canonical request

The request was constructed and strictly decoded using the canonical constructors from a clean checkout of the exact authored source above, with its pinned dependencies. The compiled strategy was checked against the reviewed Nix identity.

| Binding                 | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| Request hash            | `28d4b9da0bad2a6b0ddba5e57d94de5716405553c277011fbd974eceb6558542` |
| Research plan hash      | `45b6a9dae024016b9a2603832ca1dfaf8766797c6638020654267ef8f566c6b5` |
| Account-bound risk hash | `9bd25211f45c8026b360cc5bc7f86bc91fcc2093fe1f80c1cede6d742e1f1717` |
| Strategy                | `jev`, `bayn.intraday-alpha-policy.v2`                             |
| Behavior hash           | `d04cc79fb733975def34d2f2ced4f0d647bc76ed17fa2506e677d4dc73ba28de` |
| Parameter hash          | `f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509` |
| Protocol hash           | `5863a919110021b7bf7f27872aafe0bed44092cf832f8d0e3a6fdb66fb73ff2d` |
| Ciphertext SHA-256      | `37f9ad603db74d66391637ec40517e23ff2a1f6663dbfaaaa9a5f425039856b1` |

The existing v6 PAPER policy caps each order and symbol at $40,000, gross exposure at $180,000, net exposure at $100,000, daily loss at $5,000, and drawdown at $10,000. Its existing daily-turnover setting is uncapped. Request limits of zero open orders and zero positions require an empty activation boundary; they do not replace the runtime order and exposure limits. The request explicitly resolves the account-bound sandbox risk hash.

Independent preparation used the installed controller's active public certificate and strict scope for namespace `bayn`, Secret `bayn-alpaca-auth`. Concurrent [PR #16345](https://github.com/proompteng/lab/pull/16345) merged as `60d55abaaf1c451e23284bce7752196fb6e024c0` with the identical canonical request, plan, risk and strategy identities. This follow-up preserves that reviewed SealedSecret byte-for-byte, including its ciphertext hash recorded above. The independently prepared randomized ciphertext was never deployed. Existing account and broker credential ciphertexts remain unchanged; this follow-up introduces no further mandate change.

## Delivery and acceptance

The reviewed follow-up source contains the broker recovery fix and evidence corrections with unchanged strategy, risk-policy, activation-constructor and Nix identity sources relative to the authored build. Git ancestry was checked explicitly. Kargo preserves the authored request binding and supplies the promoted physical source/image endpoint to all three runtime manifests. This is a native same-account PAPER research request; no live capital is authorized.

Merge and publish through normal CI, immutable cohort, automatic Kargo promotion and Argo synchronization. Only the committed native GitOps hook performs activation. Final acceptance requires the expected promoted source and digest, matching request/build lineage, effective PAPER with kill CLEAR, natural controller sequence advancement, fresh EXACT reconciliation, zero unresolved mutations, and unchanged equity orders/fills while the market is closed.

This document records the request's reviewed preparation basis. It does not claim that the follow-up release or PAPER activation has already completed. After successful activation, a rollback must first use native deactivation and prove clear OBSERVE; reverting only the Secret is insufficient.

Prospective strategy evaluation follows the [current evidence guide](../../intraday-alpha-cutover.md). Keep actual PAPER fills, fees, engine contributions, baseline and quote availability, simultaneous inventory, and protection outcomes separate from the incomplete retained-bar scenario. A new configuration begins a new evaluation cohort.
