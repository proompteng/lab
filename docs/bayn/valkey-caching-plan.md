# Valkey on Bayn execution paths

Valkey is required for the shared broker observation payloads. Effect's native
`@effect/platform-node/NodeRedis` binding owns the connected client. The application
adapter supplies namespaced, expiring commands with cancellation and replica
acknowledgement. The optional lazy client and PostgreSQL payload path are removed.

## Evidence that chose the paths

The [retained baseline](evidence/2026-10-13-valkey-hot-paths.json) comes from live
Tempo traces, Loki threshold logs and PostgreSQL state. The sampled broker payload
was 768,935 bytes. The previous client rejected it at its 262,144-character limit.
A local reproduction against that exact client confirmed the rejection.

Eleven retained postclose controller traces had a median reconciliation persistence
span of 2,888.906 ms and a median broker snapshot read of 33.975 ms. Their median
commit span was 1,189.049 ms. Ten polling traces had a median capture span of
1,399.714 ms and publication span of 944.417 ms. Nested spans overlap and must not
be summed. The selection is purposive and small; these are not market-session SLOs.
Four of 48 requested trace responses were unavailable. `pg_stat_statements` was
not installed, so statement totals were derived from retained spans rather than
invented database statistics.

The source already reads one coherent broker cut per health pass. Each cut still
transferred and decoded the entire order, fill and fee history, including for
health and submission consumers that need only current account and position state.
Polling also rewrote that entire JSONB payload on each publication. Those repeated
payload costs can move out of PostgreSQL while its durable control remains intact.
Synchronous reconciliation writes and commit I/O remain a separate measured cost.
The live database already had 512 MB of shared buffers; this change does not claim
that adding a cache fixes storage latency or durable accounting work.

The [October 14 production check](evidence/2026-10-14-valkey-publication-stalls.json) found another cost in publication. Both API
hosts reproduced 731,459-byte synthetic writes that took 1.25–1.27 seconds for
`SET` and 2.25–2.59 seconds for replica acknowledgement. Four retained polling
traces hit the one-second Valkey publication deadline. Valkey reported delayed
AOF fsyncs, automatic AOF rewrites and scheduled RDB saves on the existing Ceph
volumes. These expiring materializations do not need disk persistence. AOF and
scheduled snapshots are disabled while memory replication, acknowledgement,
freshness and failure guards remain required. Diskless primary synchronization
prevents the pinned operator from silently adding default snapshot schedules.
The existing volumes remain retained.

Earlier market-session traces were also inspected. Verified market snapshot work
was materially smaller than reconciliation in this sample. A public research owner
landed on main during this work, but its new acquisition path was not in the live
baseline. Neither path gets a speculative cache or a fabricated improvement claim.

## One storage path

The account-keyed broker observation object remains the polling owner. A capture
still reserves its durable claim and HTTP quota before contacting the broker.
Publication proceeds in this order:

1. Decode and validate the complete cut, including account identity and original
   observation times. Reject a poll that does not match its durable ticket.
2. Write the immutable full snapshot and compact state under content-addressed
   `bayn:broker:` keys. Keys hash the account binding, source revision and content
   identity. Each write must receive an acknowledgement from one replica.
3. Commit both content hashes and availability in PostgreSQL under the existing
   generation, mutation and broker-event predicates. Settle the capture claim in
   that same statement. A rejected publication leaves expiring, unreachable keys.

The compact value contains current account, positions, account configuration,
open-order evidence, the latest order and fill probes, and original observation
times. It includes its parent full-snapshot hash. Its independent hash and parent
binding prevent a mixed full and compact cut from being accepted.

Reconciliation retrieves the full snapshot. Continuous health, account and
position reads, configuration and recent-history probes, and the final submission
preflight retrieve compact state. Each reader first checks fresh PostgreSQL
availability, source revision, age, mutation and broker-event fences. Submission
also checks its exact reserved intent and concurrent unresolved mutations. It then
decodes the selected Valkey value, verifies its hash and parent binding, and
validates account identity and chronology. Original observation times never become
cache-read times. Pending observations remain distinct from unavailable or corrupt
observations and never authorize submission.

There is no database payload fallback. A cache miss, expiry, invalid value, missing
replica acknowledgement or transport failure is an explicit failure. The polling
owner must publish another valid cut. Keys expire at the remaining observation
lifetime, bounded by the existing maximum age, rather than extending freshness.
Values are limited to 4,194,304 characters. The replica deployment retains its
existing bounded memory, `noeviction` policy and manual failover procedure.

Trading authority, writer leases, kill state, capture claims, quotas, reservations,
mutation outcomes, reconciliation truth, inference claims, TigerBeetle postings
and acknowledgements remain in their existing durable owners.

## Deployment and recovery

Migration 98 invalidates the disposable current projection, advances its generation,
adds the compact-state hash and removes the JSONB payload column. Old images cannot
read or publish after this hard cut. Do not roll back to an image that expects the
removed column. Recover forward with a repaired image and a fresh broker poll.
No historical broker event, retained snapshot, ledger record or volume is removed.

Deliver the reviewed source through Bayn CI, immutable image publication, Kargo
Stage `bayn`, its generated branch and Argo reconciliation. The API and worker
Secret and ConfigMap references are required. The native activation hook drains the
predecessor and publishes the new revision's broker materializations before it
activates execution. Image promotion grants no capital authority.

After rollout, run the installed command from the API and execution worker:

```sh
node /app/services/bayn/dist/valkey-command.js --broker
```

It verifies the transport and actual fenced materializations, then reports full
and compact payload sizes and p50/p95 over 20 paired reads. It prints no account
values, payloads or credentials. Compare the paired reads within the same image
and host. Check both host architectures, HTTP readiness, exact source and digest,
controller status and fresh polling/publication traces. Publication spans include
`bayn.broker.snapshot_bytes` and `bayn.broker.state_bytes`; materialization spans
include payload kind and bytes. Raw keys and values are excluded.

A healthy Pod or synthetic GET/SET alone does not prove this migration. Runtime
acceptance must exercise the actual broker store. Overall controller improvement
requires comparable traffic and a separate trace comparison; a smaller compact
read does not prove that synchronous database commits became faster.
