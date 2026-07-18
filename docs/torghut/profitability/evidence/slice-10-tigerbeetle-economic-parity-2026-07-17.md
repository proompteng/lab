# Slice 10 Production Evidence: Full TigerBeetle Economic Parity

Status: production-proven. Source, image, GitOps, manual parity, idempotence, sealed-storage, API, fault-injection,
recovery, and a natural Cron-owned source-race retry all passed. Slice 10 is complete; profitability and capital gates
remain blocked.

Evidence window: `2026-07-17T07:41:06Z` through `2026-07-18T04:24:58Z`.

## Invariant And Scope

The production exercise tested that the complete deterministic broker-economic journal is represented by immutable
TigerBeetle accounts and linked transfer chains, that the observer reads every expected object back, and that exact
account and transfer manifests gate entry and promotion evidence. Protocol reachability or a successful write alone is
not parity.

This is accounting-integrity evidence, not a strategy return, market edge, profitable order, capital grant, or
permission to increase exposure. Existing broker reconciliation residuals remain independent and blocking.

## Delivery Chain

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

## First Full Materialization

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

## Exact Rerun And Idempotence

Manual Job `torghut-broker-economic-parity-rerun-20260717081027` completed against the identical input and journal.
It selected zero accounts and zero transfers for creation, reused all 96 accounts and all 40,165 transaction chains,
and reproduced both manifests exactly. All error counters remained zero.

This proves object-level idempotence and complete linked-chain reuse. It does not infer parity from TigerBeetle's
duplicate-ID response.

## CNPG Sealing And Runtime Status

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

## Natural Schedule

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

## Independent Residuals And Capital Verdict

TigerBeetle parity is exact, but the broker-derived economic comparison still reports:

- `broker_cash_mismatch`;
- `ledger_position_fresh_mark_missing`;
- `ledger_position_missing_from_broker`.

The latest observation has three residuals and zero open orders. These are Slice 8 broker reconciliation blockers, not
TigerBeetle projection errors. Slice 9 also still lacks its changed-source append proof and a fresh complete paper
causal chain. Consequently P0 has not exited, no strategy has earned capital authority, and real-capital
risk-increasing submission remains blocked.

## Verdict

The implementation now proves deterministic full-object TigerBeetle economic parity, idempotent replay, sealed CNPG
bindings, fail-closed discrepancy detection, clean recovery, and bounded whole-attempt retry on the promoted production
path. This closes only the Slice 10 accounting-parity invariant. It does not close Slices 8 or 9, authorize capital, or
prove Torghut is profitable.
