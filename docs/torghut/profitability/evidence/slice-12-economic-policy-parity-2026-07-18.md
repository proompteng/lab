# Slice 12 Production Evidence: Versioned Economic Policy Parity

Status: production-proven for one pinned economic policy across replay, live-scheduler shadow, paper simulation, and
live runtime status. This controlled parity proof does not establish strategy profitability, empirical fee accuracy,
or capital authority.

Evidence window: `2026-07-18T18:12:30Z` through `2026-07-18T18:58:59Z`.

## Invariant And Scope

Slice 12 requires replay, shadow, paper, and live to load one strict policy for session handling, sizing, leverage,
participation, fees, latency, slippage, stale data, rounding, and risk limits. A caller may not silently replace the
policy, omit a custom-policy digest, or compute lineage from a partial cost model.

The terminal test is deliberately pre-broker. Each stage evaluates the same fixed AAPL sell intent and market snapshot,
then emits the policy digest and normalized pre-broker intent digest. The proof passes only when all stages approve and
both digests match exactly. It does not submit an order.

## Delivery Chain

| Boundary                 | Evidence                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source PR                | [#12810](https://github.com/proompteng/lab/pull/12810), `feat(torghut): unify versioned economic policy`                                                                                                 |
| Source merge             | `5f884334e20d6a464dcca808dac064d00227270e`                                                                                                                                                               |
| Final source-head CI     | [run 29655085540](https://github.com/proompteng/lab/actions/runs/29655085540), all required jobs successful                                                                                              |
| Image build              | [run 29655413728](https://github.com/proompteng/lab/actions/runs/29655413728), amd64, arm64, and multi-architecture index successful                                                                     |
| Image identity           | source `5f884334e20d6a464dcca808dac064d00227270e`; digest `sha256:78660b3db72dd7479aeb6b4be29bb2818352f122dbf461f4c6c25014f54798d9`                                                                      |
| Release                  | [run 29655588996](https://github.com/proompteng/lab/actions/runs/29655588996); promotion PR [#12813](https://github.com/proompteng/lab/pull/12813), merged as `520f02a3408fa425846056d4eaa1761ea41f53a7` |
| Rollout-contract fix     | [#12814](https://github.com/proompteng/lab/pull/12814), merged as `6681473258789a8cf62237817cf307767636c40e`                                                                                             |
| Fix CI                   | package run [29656190372](https://github.com/proompteng/lab/actions/runs/29656190372) and Torghut run [29656190313](https://github.com/proompteng/lab/actions/runs/29656190313), successful              |
| Corrected verifier proof | [run 29656536486](https://github.com/proompteng/lab/actions/runs/29656536486), runtime contract, market-data gate, and evidence upload successful                                                        |
| Final fix-image build    | [run 29656530362](https://github.com/proompteng/lab/actions/runs/29656530362), both platforms and index successful with unchanged application-image content digest                                       |
| Final release            | [run 29656610196](https://github.com/proompteng/lab/actions/runs/29656610196); promotion PR [#12815](https://github.com/proompteng/lab/pull/12815), merged as `c1c625b1b164da211de3bb20bdbe5103d2d424b9` |
| Final automatic proof    | [run 29656708822](https://github.com/proompteng/lab/actions/runs/29656708822), runtime contract, market-data gate, and evidence upload successful after final promotion                                  |

The source change passed 31 focused regression tests on its final reviewed head, the complete PR matrix, strict
Pyright for the application and scripts, Ruff, bytecode compilation, the Pylint structural/design/file-length gates,
PostgreSQL mutation-fencing integration, Argo lint, and Kubernetes schema validation. Six substantive review findings
were corrected before merge:

- economic-policy projection now preserves configured minimum and maximum notional caps;
- fee/TCA fallbacks use the effective runtime policy rather than the bundled default;
- replay validates the expected policy digest;
- regulatory-fee rounding participates in cost-model and lineage hashes;
- programmatic replay builders inherit environment policy pins; and
- every custom replay policy path requires an expected digest.

No service, queue, controller, database table, migration, alternate scheduler, or second policy authority was added.

## Rollout Defect Found And Corrected

The first post-deploy run exposed a stale assertion in the existing TypeScript verifier. The promoted runtime correctly
reported the new policy's `1.0` gross-exposure limit, while the verifier still required the retired `4.0` value. Pods,
Argo, and policy parity were healthy, but the full runtime contract could never converge.

The known-doomed run was canceled after the mismatch was independently reproduced. PR `#12814` changed only the
executable expected value, its operator summary, and the existing regression fixture. Its 33 focused tests prove that
`1.0` passes and `4.0` is now rejected as drift. Normal and type-aware Oxlint and Oxfmt passed; full CI passed before
merge. The corrected post-deploy run then passed the Argo, workload, health-endpoint, capital-limit, ledger,
simulation, market-data, and evidence-upload gates.

This was a contract repair, not a relaxation: the production limit stayed at the more conservative `1.0` throughout.

## Runtime Policy And Intent Parity

The consolidated verifier executed replay from the merged source, shadow inside the singleton scheduler container, and
paper inside the active simulation revision. It asserted the stage set, approval booleans, schema, fixture, policy ID,
policy digest, and intent digest rather than comparing console text by inspection.

```json
{
  "approved_stages": ["paper", "replay", "shadow"],
  "economic_policy_digest": "sha256:071068019c37c8f6e7d379529e6506661429d88bb082e876bfca2df221bc4d65",
  "fixture_id": "aapl-sell-10-v1",
  "intent_digest": "sha256:a479fe7f74d2ea5df232214dd8aaf0fed906b7d18cef0393381cd1c4e09fb2e7",
  "parity": true,
  "policy_id": "alpaca-us-equity-v1",
  "schema_version": "torghut.economic-policy-parity.v1"
}
```

Direct final live-scheduler status independently reported:

- build commit `6681473258789a8cf62237817cf307767636c40e` and the promoted image digest; the verifier-only
  change did not alter application-image content, so the digest remained identical to the Slice 12 source image;
- mode `live`, enabled and running;
- economic policy configured and valid, with the same policy and fixture-intent digests;
- an empty `runtime_mismatches` list;
- service health true; and
- broker-mutation fencing wired and current, with entry and reduction fencing proven and zero unresolved submit or
  reduction receipts.

## GitOps And Singleton Readback

After the final verifier-fix promotion, `torghut` reported `Synced`, `Healthy`, and operation `Succeeded` at GitOps
revision `c1c625b1b164da211de3bb20bdbe5103d2d424b9`. The application-image digest remained the Slice 12 digest above;
the runtime build annotation advanced to the reviewed verifier-fix merge.

Live workload readback showed:

| Runtime          | Active object                  | Desired | Ready | Image                    |
| ---------------- | ------------------------------ | ------: | ----: | ------------------------ |
| API              | `torghut-01533-deployment`     |       1 |     1 | promoted Slice 12 digest |
| Paper simulation | `torghut-sim-01605-deployment` |       1 |     1 | promoted Slice 12 digest |
| Scheduler        | `torghut-scheduler`            |       1 |     1 | promoted Slice 12 digest |

Both Knative Services had identical latest-created and latest-ready revisions with `Ready=True`. Ten retained Knative
Deployment objects remained as rollback history at zero desired replicas. They were not active trading owners. The
scheduler Deployment had one desired, updated, ready, and available replica at observed generation 109.

## Capital And Profitability Verdict

Capital remains fail-closed. The live scheduler's capital-control reducer reported its internal ledger current and its
new-exposure subcheck true, but the final action-authority reducer still reported both `entry_allowed=false` and
`reduce_only_allowed=false` because the mainnet route was unavailable. The service was healthy and recovery was not
degraded. No risk-increasing broker mutation was authorized by this exercise.

The final market-data check ran during `weekend_closed`. It passed the closed-session contract but does not prove low
lag during an open session. Direct status showed an accepted TA event age of 80,961 seconds and market-context age of
79,071 seconds, both classified as expected closed-session staleness. Scheduler processing itself was current: the
loop was about one second old and reconciliation about seven seconds old. The last persisted strategy decision was
from `2026-07-16T17:49:40Z`; the next open session must prove fresh inputs and renewed decision production before this
evidence can support any claim about live opportunity capture.

The parity fixture proves deterministic policy application, not positive expected return. Fee bases are modeled and
must remain non-promotion-grade until empirical broker/TCA evidence validates them. Slice 13 must now bind immutable
point-in-time input receipts; Slice 14 must prove the full execution-envelope digest. Paper probation, selection-
adjusted profitability, capacity, accounting, route, and strategy-capital gates remain independently blocking.

## Reproduction Commands

The terminal checks used only controlled fixture output and bounded status projections; no broker account identifiers,
balances, exchange order IDs, credentials, database system identifiers, or raw logs were recorded.

```bash
cd services/torghut
uv run python scripts/verify_economic_policy_parity.py --stage replay

kubectl -n torghut exec deployment/torghut-scheduler -c torghut-scheduler -- \
  python /app/scripts/verify_economic_policy_parity.py --stage shadow

kubectl -n torghut exec <active-paper-pod> -c user-container -- \
  python /app/scripts/verify_economic_policy_parity.py --stage paper

kubectl -n argocd get application torghut -o json
kubectl -n torghut get kservice torghut torghut-sim -o json
kubectl -n torghut get deployment torghut-scheduler -o json
```

Rollback remains fail-closed: pin the last verified policy digest and image with trading capital disabled. Never restore
stage-specific defaults or accept a custom policy path without its digest.
