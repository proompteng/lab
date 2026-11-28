# Bayn v3 Pure ETF PAPER cutover

> **DO NOT MERGE UNTIL MONDAY 2026-11-30 AFTER GOOGL -103 SETTLES FLAT.**
> Not before **09:30 ET** on that date; the clock alone does not satisfy the gate.

This is a change to the strategy running in the production Bayn service on the existing **Alpaca PAPER** account.
It does not authorize live capital. [Black Friday close forensics (#16371)](https://github.com/proompteng/lab/pull/16371)
identified the incumbent's GOOGL short and the early-close recovery issue. Leave the incumbent, its credentials, and
its order owner intact until reconciliation proves settlement. Do not cancel or invent orders to pass the gate.

## What changes

- Only QQQ and SMH can open positions. The existing `torghut-core-equity-v3` IEX universe and completed SPY benchmark
  remain unchanged. The 30-minute checkpoints are 10:00 through 15:00 ET, or through 12:30 ET for a 13:00 ET close.
  Each band uses the last 14 prior provider sessions that reached that checkpoint and a **1.4×** mean absolute swing
  from the session open, anchored to the more distant of today's open and the prior close. The last 14 sessions'
  open-to-close sample volatility, floored at **10 bp**, sets inverse-volatility weights. Whole-share orders are
  constrained by **1.0** gross weight, **0.65** per ETF, two positions, and the independent PAPER risk gates
  ($180,000 gross, $100,000 net, $117,000 per ETF/order).
- Entries allow **25 bp** from the completed bar. The entry bracket protects the pending fill. After terminal entry
  and exact fill accounting, the controller replaces stale bracket levels with the actual quantity-weighted entry
  fill anchor: **1.5× ATR14** stop (150–600 bp), **max(50 bp, 0.25× ATR14)** stop-limit collar (150 bp cap),
  and a 1,500 bp profit limit. A replacement cancellation is not an exit request. An opposite-band close still
  triggers when the band has zero width. The provider's regular close determines mandatory flattening at
  **15:58 ET** or **12:58 ET**. A stop-limit can still go unfilled beyond its limit; keep native recovery and
  reconciliation running until inventory and orders are settled.
- [Wave 5A (#16377)](https://github.com/proompteng/lab/pull/16377) found losses for the single-stock engines on unseen
  2016–2023 sessions. The matched B0 cell in [Wave 6A (#16387)](https://github.com/proompteng/lab/pull/16387) earned
  **$31,628** at 5 bp in 2024–2026 Holdout and **$69,780** across 2,741 sessions at the same modeled cost.
  B0 was a matched retrospective comparison, not the frozen primary. SIP bars, simulated fills and research exit
  clocks are not evidence of PAPER fills or profitability in IEX. [#16356](https://github.com/proompteng/lab/pull/16356)
  and [#16359](https://github.com/proompteng/lab/pull/16359) motivate separating entry tolerance from stop-limit protection.

## Compiled identity

| Field                                               | Value                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| Strategy                                            | `jev`                                                                  |
| Policy schema                                       | `bayn.intraday-alpha-policy.v3`                                        |
| Assessment engine                                   | `INTRADAY_ALPHA_V3`                                                    |
| Observation / target                                | `bayn.intraday-alpha-observation.v3` / `bayn.intraday-alpha-target.v3` |
| Behavior hash                                       | `35534271edfc916e5a2801b31cfb3fc4b3d2640209666fc22c831401040fb58b`     |
| Parameter hash                                      | `40d0643d63c368dd207d0f6a55b3feadb673dbd74b7c8b82bd7ee8d52e256eb5`     |
| Protocol hash                                       | `91fab8597a5a70b8aed72c5d709040a775f4718905293bc2f438ec5124a4d100`     |
| PAPER risk hash for the build sentinel account only | `c2aba157b7956d1f5a739928c7d6b8de3973de6868a25760fbc528d7aa1a8b1c`     |

The v2 identity was evaluated with `loadActiveStrategyProtocol` on the original main revision
[`18b587d91`](https://github.com/proompteng/lab/commit/18b587d91ebee7210ec1e92db9af17eeda2586fd).
Migration 0229 matches its exact behavior, parameters and protocol. Historical evidence is not rewritten.

## Merge gate

After Monday's open, verify the **same** PAPER account has no GOOGL position at the broker, the latest
`position_snapshots.position_count = 0`, every intent and cycle is terminal, every broker order is settled, all fills have
accounting transactions and receipts, the inventory and cost basis are flat, and there are no unexpired unresolved
inference claims. The latest account reconciliation must be `EXACT`, no more than 60 seconds old, and no earlier than
the last account mutation. Bring the exact snapshot and reconciliation IDs and the terminal broker/ledger evidence to
the PR. Recheck immediately before the rollout because a Friday receipt or a Monday flat receipt followed by another
fill is not sufficient. Migration 0229 repeats the settlement proof under locks. It restricts only the exact clear v2
PAPER authority to `OBSERVE / ACTIVE / BLOCKED_STRATEGY_PROTOCOL_CUTOVER`. Operator holds are not cleared.

## Promote v3 to OBSERVE

1. Squash the reviewed PR only after the settlement gate and required CI. Record its exact `main` commit. Use the
   [normal release path](../release-automation.md#application-enrollment) to verify the successful main publication
   and matching OCI source and build receipts for `lab/bayn`, `lab/bayn-research`, and `lab/bayn-broker-feed`.
2. Check the exact selected Freight and automatic Stage result in `bayn-release/bayn`. Read the Stage-generated
   `kargo/bayn` commit and verify the rendered image digests, source revision, and v3 hashes. Argo's Bayn
   Application in `argocd` must follow that commit. If manual sync is necessary, sync only that verified revision;
   do not bump images, retag images, or invoke the activation handler manually.
3. The old encrypted request is **not mounted** by v3; Kargo writes no mandate lineage without the corresponding
   environment field. Confirm migrations 0228 and 0229, new controller ownership, maximum/effective `OBSERVE`,
   kill `CLEAR` with no restriction, terminal predecessor work, exact reconciliation, and no unresolved mutations.
   Record a v3 prepared baseline and a checkpoint observation under v3 (no broker entry in OBSERVE). Stop if
   evidence is missing. A standalone health check is not proof of the cutover.

## Separate reviewed PAPER activation

Use the same broker account, sandbox identity and credential keys. Do not reuse the v2 request or its grant hash.

1. In a private operator workspace with `umask 077`, author a new
   [ResearchCapitalActivationRequest](../../services/bayn/src/execution/configuration.ts) with
   `schemaVersion: bayn.research-execution-mandate.v1`. Set `activation` to the verified OBSERVE image's
   `sourceRevision`, `imageRepository`, and `imageDigest`. Bind `strategy` to the four strategy fields above plus
   `protocolHash`; bind `broker` to `environment: sandbox`, the verified `accountId`, and its
   `identityHash` from `makeBrokerIdentity`. Use the canonical hash of
   `makeExecutionRiskPolicy(accountId, policy.sharedProtocol.universe, BrokerEnvironment.Sandbox, true)`, not the
   sentinel hash. Set activation `limits` to `{ "maxOpenOrders": 0, "maxPositions": 0 }`.
2. Compute the plan hash with `makeResearchCapitalPlanHash` using `bayn.research-execution-plan.v1` and the same
   activation, strategy, broker, risk hash and limits. Set `grant` to
   `{ "_tag": "Research", "planHash": "<computed hash>" }` and call `makeResearchCapitalActivationRequest`.
   Validate the resulting `request.json` with `decodeCapitalActivationRequestResult` before sealing. It is private;
   do not log it, pass it as a command-line argument, or commit it.
3. Seal only that value, with strict name/namespace scope, using the target cluster controller. Preserve the
   existing encrypted account, key ID and secret key fields byte-for-byte.

   ```sh
   umask 077
   work=$(mktemp -d)
   trap 'rm -rf "$work"' EXIT
   # Set request_file to the private, validated request.json from step 2.
   kubeseal --context galactic-lan      --controller-name sealed-secrets --controller-namespace sealed-secrets      --fetch-cert > "$work/cert.pem"
   kubeseal --raw --scope strict --cert "$work/cert.pem"      --namespace bayn --name bayn-alpaca-auth --from-file "$request_file" > "$work/ciphertext"
   ciphertext_hash=$(tr -d '\r\n' < "$work/ciphertext" | sha256sum | cut -d ' ' -f 1)
   manifest=argocd/applications/bayn/alpaca-sealedsecret.yaml
   CIPHERTEXT=$(cat "$work/ciphertext") yq -i \
     '.spec.encryptedData."capital-activation-request" = strenv(CIPHERTEXT)' "$manifest"
   jq -cS --arg hash "$ciphertext_hash" \
     '{authoredActivation: .activation, requestHash, strategy, ciphertextHash: $hash}' \
     "$request_file" > "$work/identity"
   IDENTITY=$(cat "$work/identity") yq -i \
     '.metadata.annotations."proompteng.ai/bayn.mandate-identity" = strenv(IDENTITY)' "$manifest"
   kubeseal --context galactic-lan      --controller-name sealed-secrets --controller-namespace sealed-secrets \
     --validate < "$manifest"
   ```

4. In the **same activation PR**, restore these fields on the named container in `deployment.yaml`,
   `execution-controller.yaml` and `execution-activation.yaml`:

   ```yaml
   - name: BAYN_CAPITAL_ACTIVATION_REQUEST
     valueFrom:
       secretKeyRef:
         name: bayn-alpaca-auth
         key: capital-activation-request
         optional: true
   - name: BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE
     value: '{}'
   ```

   Do not change the read-only bootstrap access or static capital mode; the native request grants PAPER after
   settlement. Verify `bun test packages/scripts/src/bayn/kargo.test.ts`, review the ciphertext and binding hashes
   without disclosing plaintext, and deliver by the same main → image → Kargo → Argo path. Kargo fills the exact
   build lineage. Argo orders the Secret (-2), controller (-1), activation hook (0), and read-only status/feed (1).

5. Require effective PAPER on the bound account, exact reconciliation, zero unresolved mutations, and advancing
   controller evidence. On the first eligible session, inspect the actual v3 observation, order, fill-anchored
   protection, close and posted accounting. Do not submit a test order. An unfilled session cannot establish the
   fill or close behavior. If activation or protection fails, stop new exposure through the established reviewed
   OBSERVE transition and reconcile residual orders/positions under the existing owner; do not restore v2
   ciphertext alone or remove a controller holding positions.
