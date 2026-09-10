# Slice 10 Production Evidence: Full TigerBeetle Economic Parity

Status: production-proven in the current reducer v5 and TigerBeetle projection v3 namespace. First materialization,
an exact zero-write manual rerun, sealed CNPG readback, and the required natural hourly zero-write run all passed.
Reducer v4/projection v2 and v1 remain below as historical evidence only. Profitability and capital gates remain
blocked.

Evidence window: `2026-07-17T07:41:06Z` through `2026-07-18T11:48:49Z`.

## Invariant And Scope

The production exercise tested that the complete deterministic broker-economic journal is represented by immutable
TigerBeetle accounts and linked transfer chains, that the observer reads every expected object back, and that exact
account and transfer manifests gate entry and promotion evidence. Protocol reachability or a successful write alone is
not parity.

This is accounting-integrity evidence, not a strategy return, market edge, profitable order, capital grant, or
permission to increase exposure. The source correction removed the three historical broker residuals, but order
lineage, runtime-ledger, strategy-evidence, and capital-authority gates remain independent and blocking.

## Current V5/V3 Production Proof

PR `#12781`, merged as `e4d64be1a15400cf6a531451eba72e3934afc66e`, corrected the remaining identity defect
without adding a service, table, queue, cursor, or repair writer. The first publication in a reducer namespace retains
economic ordering. Subsequent publications hash-validate and preserve that exact published prefix. A newly observed
date-only `CFEE` may append only when complete canonical-journal and independent-state replay prove identical final
economics. A missing historical trade, correction, malformed manifest, duplicate, or unsafe late fee fails closed and
requires a new reducer and projection namespace.

The deployed v5 publication reused the closed 40,172-activity input manifest
`283dc4710eb3da7a0c6656c709277679509b66749caaf418e9c96c5e50be3a60` and produced:

- journal run `3c0d04a9-5c1f-4322-b590-6730ebe26958`, containing 40,172 transactions and 195,207 entries;
- state run `f9e1dbd5-edc1-4ce2-a6d0-f31ed4c1a947`;
- journal digest `dffcf45fb2dd62768cb6da768dd6835ac0b3b5a27be7ebe5d1ce31635842e465`;
- journal projection digest `890f24ec765e204491022656453553255a51547acef7d4f57e1d01c4cc200918`;
- state projection digest `dec6a3f32cab6a349eab514872d311b0601064568a68a5013f001acc48482cd9`;
- comparison digest `e2b8e72304aee0ef8577ca1b90a2063b37d3adb5e181c3cec1599e75826a23ee`;
- exact reducer equivalence, admissibility, zero unsupported activities, zero broker residuals, and zero open orders.

Manual first materialization used deployed source `dd5b56089b2ee8229684c5b4dc2255bb775ea65b` and image
`sha256:3595fc32a40461b4b5085c6aede61c9bc1a7efaa6bbe9a31388f83695d880935`. It created all 96 expected
accounts and 114,935 expected transfers across 40,172 linked transaction chains. Exact readback reproduced account
manifest `69eb4089d25c4994e88df5ccaacb4831102695106815f9fda16c984af817e603` and transfer manifest
`1847fbe1cfb8f54556097d2865ed0f107ce3a9c0f016e93de629f3da8a84e454`. Every create, lookup,
missing, mismatch, partial-chain, and blocker count was zero.

The immediate rerun used descendant source `240795bf6c3344f75f622498d086b429d9c59f22` and image
`sha256:451f6d40fc4882a5b13467e62c36ebc7a3a56518874d1d547fea7d00960e9f4c`. It reused the same
published input and reducer runs, selected zero accounts and zero transfers for creation, observed all 96 accounts and
all 40,172 existing transaction chains, and reproduced both manifests exactly with zero errors or blockers.

Direct CNPG readback independently confirmed the persisted 195,207 entries, 40,172 distinct transactions, exact
v5 input/run/comparison bindings, and two latest v5/v3 reconciliation rows with `reconciled=true`, zero residuals,
zero open orders, exact parity, and zero blockers. The first row recorded all creates; the second recorded none. Both
correctly retained `capital_authority=false` and `promotion_authority=false`.

The manual Jobs were removed after readback; no ad hoc child Job remains.

### Natural v5/v3 proof

The CronJob controller created Job `torghut-broker-economic-ledger-reconciliation-29739587` at
`2026-07-18T11:47:00Z`; it completed at `11:47:31Z` with one pod, zero container restarts, and no Kubernetes retry.
The immutable child Job retained
`backoffLimit: 0`, the 1,200-second active deadline, source `d5d9bd4b9003431c62214982b1fe550d7e9c9c1e`, and image
`sha256:66ac029b53896d28e9d2f64dcf2599b2fef13ac2c2fac1d97d934ac7b6c09dc6`.

CNPG sealed observation `564ef45b-d9b8-475f-95bc-9c6c21d4d9a5`, observed at
`2026-07-18T11:47:09.953091Z`, with result digest
`3cb41858d5ba6c305b63fc9e363070d4ecce34ea127b3d061e4ae22c32c6d309`. It reused the same input, journal,
state, comparison, account-manifest, and transfer-manifest bindings as the manual v5/v3 proof. It selected zero
accounts and zero transfers for creation, observed all 96 existing accounts and 40,172 existing transaction chains,
and matched all 114,935 expected transfers. Every TigerBeetle error, blocker, exception, broker residual, and open-order
count was zero. Independent SQL recomputation matched both stored canonical-document hashes.

Direct scheduler status resolved the same observation as current, reconciled, admissible, differentially equivalent,
and `accounting_parity_satisfied=true`. The nested v3 payload retained exact parity while correctly keeping
`capital_authority=false` and `promotion_authority=false`.

## Historical V4/V2 Correction: Late-Fee Monotonicity

The v1 projection was exact for the source rows visible during its original evidence window. It was not stable under a
late broker fee whose economic date preceded its observation time. The later source readback therefore invalidated the
v1 materialization as current proof even though the original run, rerun, and readback were internally consistent.

### Source correction

PR `#12764`, merged as `0676c7dc1e36e42abf0f8ab21798b0d9577ac727`, extended broker-activity backfill to a
bounded two-day overlap. Production source evidence changed from seven to fourteen `CFEE` activities: six asset fees
and eight cash fees. The previously reported three broker reconciliation residuals fell to zero. The overlap does not
invent a new accounting authority; the existing natural-key upsert remains the only source writer.

### Why projection v1 could not be reused

Date-only cash-fee rows were originally ordered by economic date and external ID. A fee first observed on the next day
could have a lexically earlier external ID than a fee already projected for the prior economic date. Inserting it into
the middle of the state-dependent fee and rounding chain changed existing deterministic transaction identities.

TigerBeetle is correctly immutable, so the v1 namespace retained the old chains while the recomputed projection
expected replacements. Five account cumulative-balance fields then mismatched even though the newly expected transfer
count and manifests were internally exact. The system did not delete transfers, overwrite accounts, tolerate the
mismatch, or relabel it as parity. Projection v1 is permanently retained as historical evidence and permanently barred
from current authority.

### Reducer v4 and projection v2

PR `#12766`, merged as `aca95091f629ca433fac687e61034da64ac3063e`, introduced reducer v4 and TigerBeetle
projection v2. It retained economic-time ordering and used first-observed time to break ties among date-only fees with
the same settlement date. That rule did not preserve the published prefix when a newly observed fee had an earlier
settlement date than already published later activity; v4/v2 is therefore historical rather than a current ordering
guarantee. Promotion PR `#12769` merged as `42b2b9aa2103fba8eaa263d4dcd95f2d1b6c1e3a`; the correction image was
`sha256:44131fdc982d4a956d0d956790d68198cf309dcda1f3d4d97834ac741a6e7ab9`.

The published v4 input and reducer pair contained:

- input `39d45f12-fb08-40e4-9ef5-e06c01baa8d6` with 40,172 source activities and manifest
  `283dc4710eb3da7a0c6656c709277679509b66749caaf418e9c96c5e50be3a60`;
- journal run `a0fa236d-9469-49ce-830a-990dac3d710c`, 40,172 transactions, 195,207 entries, and digest
  `dffcf45fb2dd62768cb6da768dd6835ac0b3b5a27be7ebe5d1ce31635842e465`;
- state run `e3f82f54-c7c2-4f04-bc77-dfd65e0020a2` and comparison digest
  `20b82b73a05d5b46e9f6314ba3503133a1ea0ab0312632282504095b313b41b3`;
- exact reducer equivalence, admissibility, zero unsupported activities, and zero broker residuals.

Manual Job `torghut-broker-economic-ledger-v2-parity-1-0610` performed the first v2 materialization. It created all 96
expected accounts and 114,935 expected transfers across 40,172 linked transaction chains. Exact readback reproduced
account manifest
`23131300047a58dff2b80ceee0c75d3d5988a2f36a6c8f6771948b047e157d50` and transfer manifest
`3241194bfa1ecfb5dd567487ff531374bb8fa5252057dc554b5d528bba01bb1e`. Every create, lookup,
missing, mismatch, and partial-chain error counter was zero.

Immediate rerun Job `torghut-broker-economic-ledger-v2-parity-2-0612` selected zero accounts and zero transfers for
creation, reused all 96 accounts and all 40,172 transaction chains, and reproduced both manifests exactly with every
error counter still zero. The completed manual Jobs were removed after the evidence was recorded; the immutable
TigerBeetle objects and sealed PostgreSQL records remain.

### Natural v4/v2 proof

Cron-owned Job `torghut-broker-economic-ledger-reconciliation-29739287` started at `2026-07-18T06:47:00Z` and
completed at `06:47:48Z` on source `a6ee6c1f529d8c6240e3535c15152b57605179db` and image
`sha256:bfadb9f0fd415d8884f74de9551a2f4740a8c89dd6d36f1de16f34606085a995`. It used Kubernetes
`backoffLimit: 0`, a 1,200-second active deadline, and the bounded 180-second source-consistency retry contract.

The natural run proved:

- reducer v4 equivalence and admissibility with zero reconciliation residuals and zero open orders;
- projection v2 parity with 96 accounts, 40,172 chains, and 114,935 transfers;
- zero selected account or transfer creates, 96 existing accounts, and 40,172 existing chains;
- exact expected-versus-actual account and transfer manifests and zero TigerBeetle errors or blockers;
- sealed observation `6f311274-80a7-4aaa-a603-e669fc078460`, result digest
  `3260f0f3b1fda0757a197efba9d1f09e86673365914b1ee0e2e97cbba6e8c793`, and exact input, run, reducer,
  comparison, journal, source-commit, and image bindings.

Direct scheduler status then reported the economic observation current, reconciled, admissible, and
`accounting_parity_satisfied=true`. The parity payload still correctly reported `capital_authority=false` and
`promotion_authority=false`; accounting truth alone does not authorize a strategy or exposure.

This run proved exact consistency for its closed snapshot. It did not prove prefix stability under a later cross-date
fee and has been superseded by the v5/v3 production evidence above.

## Historical V1 Delivery Chain

| Boundary                | Evidence                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source PR               | `#12727`, `feat(torghut): enforce broker economic TigerBeetle parity`                                                                                                                                                                       |
| Source merge            | `d2ffb65c8b773e54189f6a6ff5fc924b0b2d7db3`                                                                                                                                                                                                  |
| Local focused tests     | 209 relevant tests passed                                                                                                                                                                                                                   |
| Local static gates      | Ruff, Python compilation, structural Pylint, changed-line Pylint, file-length and debt ratchets, migration graph, Argo schema, documentation formatting, and all five Pyright profiles passed                                               |
| PR CI                   | Four pytest shards, two autoresearch shards, aggregate coverage, Pyright, lint/migrations, PostgreSQL fencing, security/complexity, Argo lint, and kubeconform passed                                                                       |
| Initial image build     | Workflow `29563866043` built and published `linux/amd64` and `linux/arm64`                                                                                                                                                                  |
| Image identity          | `registry.ide-newton.ts.net/lab/torghut@sha256:5dd97b82ac388ea9d3815119881fc5802d627d8558b0408f03923b4197b9783b`                                                                                                                            |
| Initial release         | Workflow `29564033225`; promotion PR `#12728`, merged as `a04e74142959c27ccd05bf522459851667a3b693`                                                                                                                                         |
| Runtime fix             | `#12730`, `fix(torghut): allow TigerBeetle observer io_uring`; 14 added lines across the CronJob, its contract test, and the normative design                                                                                               |
| Runtime-fix merge       | `320072e7ab9cb4ebe3ab1b4e4f9ea69f35ea7e8a`                                                                                                                                                                                                  |
| Runtime-fix image build | Workflow `29565282279` rebuilt and verified both platforms; the application image content digest remained identical                                                                                                                         |
| Runtime-fix release     | Workflow `29565406734`; promotion PR `#12731`, merged as `d2d7b135e6fb3617741990dc4fa6f84dbc5364ce`                                                                                                                                         |
| Source-race fix         | `#12749`, `fix(torghut): retry broker source races`; merged as `63e5bdd8a837aa1e601908c46a9c0fc4e0dc71f0`                                                                                                                                   |
| Retry image build       | Workflow `29569621218` built the exact retry merge; workflow `29571061765` rebuilt newer `main` source `98b1f0966ffa6707f02d336119c34754bd565fe1`; both verified `linux/amd64` and `linux/arm64`                                            |
| Retry image release     | Workflow `29628170902`; promotion PR `#12754`, merged as `cd4f6868fe3b9ef64ee2af82761347374a342db2`; digest `sha256:6e1d65a31f7c4657ef8140ec4ed92bc521738099fdd07844246d41ccafe86b5a`                                                       |
| Runtime activation      | `#12755` added only the bounded Cron argument, its manifest contract, and operating documentation; merged as `94d5f2ab2440c66e690e84a9380c94b3d9bcb946`                                                                                     |
| CI baseline repair      | `#12758` froze two expired options-catalog test clocks without changing production code; merged as `6709bc4349f7810d2ba7e2add1780ba42325e9de`                                                                                               |
| Merge-commit CI         | Workflow `29629118202` passed all four pytest shards, both autoresearch shards, aggregate coverage, five Pyright profiles, lint/migrations, PostgreSQL fencing, and quality gates                                                           |
| Final image build       | Workflow `29629118277` built and published both platforms plus the index for activation merge `94d5f2ab2440c66e690e84a9380c94b3d9bcb946`; content digest remained `sha256:6e1d65a31f7c4657ef8140ec4ed92bc521738099fdd07844246d41ccafe86b5a` |
| Final release           | Workflow `29629174161`; promotion PR `#12760`, merged as `a52f9632a7e1d941c1b395b9bc7a577e6fe2867b`                                                                                                                                         |

The activation PR's individual tests and static gates passed, but its aggregate job started after GitHub had merged the
PR and removed `refs/pull/12755/merge`; that checkout failure is not counted as passing CI. The merge-commit workflow
above reran the complete matrix and aggregate against immutable commit `94d5f2ab2440c66e690e84a9380c94b3d9bcb946` and
passed before the natural production run.

The deployed broker-economic CronJob reports that source commit, the final image digest above, and both required
platforms. Argo includes final promotion `a52f9632a7e1d941c1b395b9bc7a577e6fe2867b` in healthy descendant revision
`242c9091c1850244d613c771adfcc5022380bd2a`, reporting `Synced`, `Healthy`, and operation `Succeeded`.

No new service, queue, controller, database table, migration, or parallel accounting authority was introduced. The
implementation reuses the existing observer, append-only reconciliation row, status reducer, strategy-capital checks,
and hourly CronJob. The parity result remains explicitly `capital_authority=false` and `promotion_authority=false`.

## Production Defect Found And Corrected

The `07:47Z` scheduled Job was created during the manifest-before-image window. It received the new
`--tigerbeetle-parity` argument while still running the prior image and failed rather than silently claiming success.

The first explicit run on the new image, started at `07:52:41Z`, then terminated with exit code 139 before emitting its
result. Safe log inspection isolated a native `PermissionDenied` panic. The official TigerBeetle client requires
`io_uring`; the observer container still used Kubernetes `RuntimeDefault` seccomp. This matches the upstream
[Docker deployment requirement](https://docs.tigerbeetle.com/operating/deploying/docker/) and the TigerBeetle
[client/replica seccomp report](https://github.com/tigerbeetle/tigerbeetle/issues/3295).

The correction is deliberately narrow:

- the pod remains `RuntimeDefault` seccomp, UID/GID 999, and non-root;
- only the TigerBeetle client container uses `Unconfined` seccomp;
- privilege escalation remains disabled and every Linux capability remains dropped;
- no reusable seccomp framework, privileged pod, new service account, or alternate observer path was added.

After merge, Argo reconciled the intended source and the live CronJob exposed that exact security boundary.

## Historical V1 Materialization

Manual Job `torghut-broker-economic-parity-manual-20260717080927` completed successfully on the promoted image. Its
closed input contained 40,165 broker activities. The balanced journal contained 40,165 transactions and 195,184
entries.

The first exact TigerBeetle projection produced:

| Projection object | Expected | Read back | Created |
| ----------------- | -------: | --------: | ------: |
| Accounts          |       96 |        96 |      96 |
| Transfers         |  114,922 |   114,922 | 114,922 |

The account manifest was
`79b0621217deb2709ff4cb28827daa46eb20ef9ac2f965bb0fb4d66d8b3b92d4`; the transfer manifest was
`90446451f61b9cad3361070b4c2ea768e1c13e1bbd9885dcc1746369764722cb`. Expected and observed manifests matched
exactly. Every create, lookup, missing, mismatch, and partial-chain counter was zero after readback. Parity was true
with no parity blocker.

## Historical V1 Exact Rerun And Idempotence

Manual Job `torghut-broker-economic-parity-rerun-20260717081027` completed against the identical input and journal.
It selected zero accounts and zero transfers for creation, reused all 96 accounts and all 40,165 transaction chains,
and reproduced both manifests exactly. All error counters remained zero.

This proves object-level idempotence and complete linked-chain reuse. It does not infer parity from TigerBeetle's
duplicate-ID response.

## Historical V1 CNPG Sealing And Runtime Status

Direct `kubectl cnpg psql` readback of the final natural reconciliation independently verified:

- the result, broker snapshot, and input manifest canonical documents recompute to their stored SHA-256 values;
- observation time, source age, and maximum source age match the nested parity payload;
- input ID, input manifest, input watermark, current watermark, journal run, state run, reducer version, comparison
  digest, and journal digest all match their nested bindings;
- all eight row and truncate append-only triggers for inputs, runs, entries, and reconciliations are present and enabled;
- observation `dda28cf6-3c87-457b-98db-d53d9029be77` is bound to source commit
  `94d5f2ab2440c66e690e84a9380c94b3d9bcb946`, image digest
  `sha256:6e1d65a31f7c4657ef8140ec4ed92bc521738099fdd07844246d41ccafe86b5a`, and result digest
  `02c312cc5c735430e9cf4d2873440de7a4f475d85b0745b1828eeee322615b8b`.

Direct scheduler `GET /trading/status` returned `service_healthy=true`, a current sealed economic-ledger observation,
and TigerBeetle parity true with zero parity errors. It also truthfully kept:

- `entry_allowed=false`;
- `accounting_parity_satisfied=false`;
- `entry_dependency_satisfied=false`;
- `promotion_dependency_satisfied=false`;
- `capital_authority=false`.

The accounting parity dependency remains false because the independent broker reconciliation has three residuals.
Reduce-only is separately false because the configured Alpaca mainnet route is unavailable; recovery is not degraded.
The TigerBeetle result neither hides nor relabels either condition.

## Controlled Discrepancy And Recovery

An ephemeral Job cloned the deployed CronJob and ran the production audit through a read-only TigerBeetle wrapper. The
wrapper changed one returned account `code` in memory, delegated every lookup, and raised on either create method. It
did not import or call the persistence API.

The audit returned:

```json
{
  "blockers": ["tigerbeetle_economic_account_mismatch"],
  "create_calls": 0,
  "mismatch_fields": ["code"],
  "mutated_lookup": true,
  "parity": false,
  "persisted": false
}
```

CNPG row count, latest observation timestamp, and latest result digest were unchanged after the injected discrepancy.
The unmodified recovery Job `torghut-broker-economic-recovery-20260717081823` then returned exact parity with zero
creates, all 96 accounts and 40,165 chains reused, and both original manifests reproduced. CNPG appended one new sealed
observation for the promoted source commit. All manual and fault-injection Jobs were deleted after their proof was
recorded.

## Natural Source Race Found And Corrected

The first corrected Cron-owned run, Job `torghut-broker-economic-ledger-reconciliation-29737967`, started at
`2026-07-17T08:47:00Z` on the promoted image and failed closed with
`economic_ledger_source_cursor_incomplete`. The initial source load had acquired a complete snapshot, but the live
scheduler opened its next broker-activity scan before the publication-gate read. That scan completed at
`2026-07-17T08:48:21Z`. Direct sampling showed ordinary scans complete in about 0.4 seconds on a roughly 15-second
cadence; this was a bounded read-window race, not corrupt source data or a TigerBeetle discrepancy.

PR `#12749` therefore retries the complete observation attempt only for the four source-consistency races already
defined by the observer: option-contract-size change, incomplete cursor, changed source rows, or changed source
watermark. Each retry reacquires the broker snapshot and recomputes the journal; no stale reduction is reused. The
runtime activation is limited to 180 seconds with five-second spacing and Kubernetes backoff remains zero. All
TigerBeetle mismatches, residuals, build errors, and unknown failures still exit immediately.

The source PR contained only the replay command and its regression tests. The CronJob flag was intentionally deferred
until an image containing merge `63e5bdd8a837aa1e601908c46a9c0fc4e0dc71f0` was published and pinned, preventing
another manifest-before-image failure. Activation PR `#12755` then added the two manifest arguments. No queue,
controller, schema, service, or alternate accounting authority was introduced.

## Historical V1 Natural Schedule

Cron-owned Job `torghut-broker-economic-ledger-reconciliation-29739107` started on schedule at
`2026-07-18T03:47:00Z` and completed successfully at `03:47:37Z`. The immutable Job template independently showed:

- source commit `94d5f2ab2440c66e690e84a9380c94b3d9bcb946` and image digest
  `sha256:6e1d65a31f7c4657ef8140ec4ed92bc521738099fdd07844246d41ccafe86b5a`;
- `--source-consistency-timeout-seconds 180`, Kubernetes `backoffLimit: 0`, and a 1,200-second active deadline;
- pod-level `RuntimeDefault` seccomp and container-only `Unconfined` seccomp, with no privilege escalation and all
  capabilities dropped.

The first complete attempt failed with `economic_ledger_source_cursor_incomplete`. The process emitted one versioned
retry record for attempt 1 with a five-second delay, reacquired the complete source, and succeeded on the next attempt.
This proves the deployed retry path under the actual production race; it is not merely an argument readback or a test
fixture.

The successful attempt closed 40,165 source activities at a current watermark and age of 11 seconds. It reproduced the
40,165-transaction, 195,184-entry journal, selected zero TigerBeetle objects for creation, reused all 96 accounts and
all 40,165 linked transfer chains, and read back all 114,922 transfers. Expected and actual account and transfer
manifests matched the original materialization exactly. Every TigerBeetle error counter and blocker remained zero;
`capital_authority` and `promotion_authority` remained false.

CNPG sealed the natural observation and all top-level, reducer-run, and nested TigerBeetle bindings matched. Direct
scheduler status exposed that exact current observation and result digest with `service_healthy=true` and
`tigerbeetle_economic_parity.parity=true`, while retaining `entry_allowed=false`, all three independent reconciliation
residuals, and no recovery degradation.

## Residual And Capital Verdict

The historical v1 observation reported:

- `broker_cash_mismatch`;
- `ledger_position_fresh_mark_missing`;
- `ledger_position_missing_from_broker`.

The bounded source-overlap correction recovered the omitted fees, and the latest natural v5/v3 observation has zero
residuals and zero open orders. This supersedes the historical three-residual verdict; it does not retroactively make
the v1 or v4/v2 projection authoritative.

Slice 9 still lacks a complete current order-lineage census and a fresh, fenced paper causal chain. The runtime ledger
and strategy-capital evidence are also incomplete. Consequently P0 has not exited, no strategy has earned capital
authority, and real-capital risk-increasing submission remains blocked.

## Verdict

Reducer v5 and TigerBeetle projection v3 now prove deterministic full-object economic parity, published-prefix
validation, guarded late-fee append, idempotent replay, sealed CNPG bindings, fail-closed discrepancy detection, and a
natural Cron-owned production run. This closes only the Slice 10 accounting-parity invariant. It does not close order
lineage, runtime-ledger, strategy-validation, or capital-authority gates, and it does not prove Torghut is profitable.
