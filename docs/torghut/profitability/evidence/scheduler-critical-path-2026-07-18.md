# Scheduler Critical Path And Knative Revision Scaling Production Evidence

Status: production-proven for scheduler liveness, bounded rejected-outcome learning, and inactive API revision
scale-to-zero. This evidence does not prove strategy profitability or authorize capital.

Evidence window: `2026-07-18T04:30:00Z` through `2026-07-18T08:26:15Z`.

## Result

Torghut still needs the scheduler. It is the singleton owner of the live strategy-to-risk-to-broker loop,
reconciliation, leadership, and scheduled auxiliary work. It is not a duplicate of the Knative API and was not split,
renamed, replaced, or wrapped in another control plane.

The six `torghut-01510` through `torghut-01515` Deployments observed during the incident were Knative API revisions,
not six schedulers and not six trading owners. Only the latest revision received traffic. Old API pods remained running
because namespace Alloy scraped every revision-private metrics Service every 30 seconds, which Knative counted as
traffic. The deployed scrape correction moved API metrics collection to the stable `torghut` Service, and all inactive
revision pods then scaled to zero.

The rejected-outcome labeler now runs outside the order path and outside database transactions that span quote I/O. A
bounded fairness correction prevents structurally incomplete rows from monopolizing every batch. The existing
scheduler, table, and interval were sufficient; no new service, queue, controller, table, migration, or speculative
index was introduced.

## Runtime Ownership

| Workload                       | Responsibility                                                                    | Replica and traffic proof                                      | Trading authority                                             |
| ------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| Knative Service `torghut`      | HTTP API and stable metrics route                                                 | One current revision; `torghut-01516` received 100% of traffic | API revisions have `TRADING_ENABLED=false`                    |
| Deployment `torghut-scheduler` | Strategy loop, risk gate, broker path, reconciliation, and bounded auxiliary work | One desired, updated, ready, and available replica             | Singleton leader; direct scheduler readiness is authoritative |
| Deployment `torghut-alloy`     | Namespace telemetry forwarding                                                    | One collector scraping the stable API and scheduler targets    | No trading authority                                          |
| CNPG cluster `torghut-db`      | Durable trading and evidence state                                                | Direct SQL readback                                            | Data authority only; it cannot authorize capital              |

Knative retains five inactive revisions plus the current revision as revision history. That explains six Deployment
objects, but retained objects should normally have zero pods. A running inactive revision is therefore a scale-to-zero
or traffic problem, not evidence of another scheduler.

## Scheduler Failure And Minimal Repair

The starting production observation found 20 `IdleInTransactionSessionTimeout` failures in roughly 15 minutes. The
counterfactual rejected-outcome labeler held a PostgreSQL read transaction while performing potentially slow quote
lookups. It also executed too close to the trading loop, so a learning-only failure could consume order-path time. The
direct CNPG baseline contained 55,566 labeled and 40,776 pending outcome rows.

The repair was delivered in three narrow changes:

1. PR `#12770`, merged as `a6ee6c1f529d8c6240e3535c15152b57605179db`, moved outcome labeling to bounded
   background work, closed the read transaction before quote I/O, and isolated accounts.
2. PR `#12772`, merged as `63ed8e88080e3392daf1338a6f8cb68f56bb6d27`, used the immutable entry quote captured
   at rejection time instead of requiring a historical provider lookup for that value.
3. PR `#12774`, merged as `1e736058389a7a2ebb6b179d7ab1b7360f6f302b`, fixed the remaining head-of-line
   starvation. It scopes candidates to the scheduler account, orders by `updated_at` then event time, and advances
   `updated_at` after every bounded attempt while preserving `pending` status when required evidence is unavailable.

The first two changes reduced pending rows to 40,753 and then plateaued. Inspection of the next bounded batch showed
that its oldest 25 rows lacked a structurally valid captured quote. Retrying those same rows forever could never reach
later complete rows. Rotating attempted rows fixed that exact defect without inventing another retry system.

The fairness regression proves that a foreign-account row is excluded, an incomplete oldest row remains pending but
rotates, and a later complete row is labeled on the next batch. The regression failed against the prior ordering. The
final change passed 17 focused rejected-outcome tests, 184 relevant scheduler tests, Ruff, compileall, the structural,
quality, design, and file-length Pylint profiles, and all five Pyright profiles with zero errors or warnings.

## Knative Revision Root Cause And Repair

Live Knative state showed `torghut-01510` through `torghut-01514` as inactive and unreachable while `torghut-01515`
received 100% of traffic. Logs from each old pod showed a `/metrics` request every 30 seconds from the Alloy pod. The
Alloy discovery rule accepted every `http;torghut-[0-9]{5}-private` endpoint, so monitoring traffic kept the Knative
PodAutoscalers at one desired replica.

PR `#12774` made three related corrections:

- dynamic Service discovery keeps only explicitly named `metric` or `metrics` ports;
- API metrics use a dedicated target at `torghut.torghut.svc.cluster.local:80`, the stable Knative route;
- Mimir API availability rules select `service="torghut"` instead of matching revision-private Services.

The mounted ConfigMap updated after Argo sync, but the running Alloy process retained its old graph. Grafana Alloy does
not automatically reload a changed file; it requires `POST /-/reload`, `SIGHUP`, or a restart. A bounded live reload
returned `config reloaded`, and Alloy then reported every component healthy. Knative immediately reported desired and
actual scale zero for the inactive PodAutoscalers, and their pods terminated.

PR `#12777`, merged as `80c0087aa1dd9616a8a25cf1469c10e27352fdd3` after 19 passing checks and no
unresolved review threads, adds a pod-template annotation containing the SHA-256 of the parsed `config.river` value. A
manifest contract and the manifest-only CI path recompute the digest, so every future Alloy config change must update
the annotation and roll the Deployment. This avoids a sidecar, reloader controller, polling loop, or second
configuration authority.

## Delivery And Live Readback

Promotion PR `#12775` merged as `064e97f76655675431e1a932f9c28079ec8cfdf2`. Argo reconciled source
`1e736058389a7a2ebb6b179d7ab1b7360f6f302b` and image
`sha256:c984fa57cc4522b9eb189fe8cff6ad942b6ad8c9da5c7186de7dbc3992afa5b9`. The application read
`Synced`, `Healthy`, and `Succeeded` at that exact GitOps revision.

After PR `#12777`, Argo again reached `Synced`, `Healthy`, and `Succeeded`, now at
`80c0087aa1dd9616a8a25cf1469c10e27352fdd3`. The Alloy Deployment observed generation 17 and contained checksum
`be2adb039b3b684c22547158b61e1903100df42fb7ea797401a49bfbfd6ff01c`. Its new pod was ready with zero
restarts. Direct Alloy readback returned HTTP 200 with `Alloy is ready.` and `All Alloy components are healthy.` The
stable API scrape reported one target, forwarded samples, and zero failed scrape pools. After multiple scrapes, all
five inactive PodAutoscalers still reported desired and actual scale zero; only `torghut-01516` remained active at
one desired and one actual replica.

The completed rollout reported:

- Knative latest-created and latest-ready revision `torghut-01516`, with 100% of traffic;
- exactly one running API revision pod, ready `2/2`, with zero restarts;
- scheduler Deployment one desired, updated, ready, and available replica;
- scheduler pod `torghut-scheduler-5df8455cb8-mqtf2`, ready `1/1`, with zero restarts.

Direct `GET /scheduler/readyz` at `2026-07-18T08:08:43Z` returned `ok=true`, `running=true`, role `scheduler`,
fresh trading and reconciliation success, and required leadership acquired and healthy with no failure reason. Filtered
logs from the new pod contained 309 scheduler loop markers, zero `IdleInTransactionSessionTimeout` occurrences, and
zero error, critical, or traceback lines. Direct CNPG readback reported zero sessions idle in transaction.

Three independent CNPG samples proved continued progress across scheduler cohorts:

| UTC sample             | Labeled | Pending |
| ---------------------- | ------: | ------: |
| `2026-07-18T08:08:43Z` |  55,748 |  40,594 |
| `2026-07-18T08:09:03Z` |  55,765 |  40,577 |
| `2026-07-18T08:09:23Z` |  55,774 |  40,568 |
| `2026-07-18T08:19:11Z` |  56,188 |  40,154 |

The database is authoritative for total backlog. The in-process
`rejected_signal_outcome_label_pending_total` status metric restarted at zero with the new pod and is not a database
census; it must not be presented as proof that the durable backlog is empty.

## Operator Error During Diagnosis

An earlier diagnostic started a heavyweight Python process inside the old scheduler container. That exceeded the
container budget, terminated the scheduler with exit 137, and produced one restart. The pod recovered and reacquired
leadership before the final rollout. This was an operator-induced diagnostic failure, not the scheduler defect. No
further in-container Python probes were used; subsequent proof came from bounded service endpoints, filtered logs, and
direct CNPG queries. The final promoted scheduler pod had zero restarts.

## Capital And Profitability Verdict

The scheduler is healthy, but capital remains fail-closed. Direct scheduler status reported:

- service healthy, but entry and reduce-only action authority false because the mainnet route is unavailable;
- market session `weekend_closed`, regular session not open, and final live-submission `allowed=false`;
- zero submitted or rejected orders during the new pod lifetime, which is expected while the market and route are
  closed;
- order lineage with zero causally complete and 16,619 incomplete records, not promotion eligible;
- runtime ledger degraded and missing;
- nine enabled strategies but zero active broker capital grants;
- TigerBeetle protocol and reconciliation healthy, current, and blocker-free.

Accounting parity, scheduler health, Argo health, and scale-to-zero correctness are necessary but not sufficient for
profitability. The next eligible market session still requires a normal strategy-to-risk-to-broker lifecycle proof.
No risk-increasing capital should be enabled until order lineage, runtime-ledger, strategy evidence, route authority,
and capital-grant gates independently pass.
