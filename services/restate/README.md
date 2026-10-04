# Restate runtime patch

This build retains upstream Restate 1.7.9 at `fb0ca137d5fc1c86cda5a7d8ef653c5ab201fe6c` with two focused patches:
metadata write dispatch uses the existing background I/O executor, and connection-blocked election requests get a
bounded opportunity to reach a newly connected peer. WAL synchronization, write completion, replication, on-disk
format, and upstream tools remain unchanged. The source archive and build/runtime images are pinned. Test-only
fault injection and connection barriers are absent from the runtime image.

`docker build --target test services/restate` injects a two-second delay into real WAL `fsync`/`fdatasync` calls in an
isolated metadata store. It requires the unpatched code to fail responsiveness checks, applies the patch, then verifies
timer and TCP responsiveness, successful durable writes, and the stored Raft state after reopening the database.
It also runs the upstream metadata storage tests. The injector must report an actual WAL sync or the proof fails.

The cold-peer proof emits real Raft pre-vote and vote requests through `Member::on_ready`, holds a loopback connection
cold, then registers its production outgoing channel behind a test-only readiness barrier. One normal Raft tick must
deliver the exact request without a second campaign. Both cases must fail for the specific dropped-request reason
when only the election patch is reversed, then pass with it applied; vote hard state must already be durable.
Separate tests cover repeated same-term campaigns, successful replacement sends, stale role/term/configuration,
removed voters, address changes, expiry, full/closed channels, snapshots and independent-peer progress.

Only `Connecting` pre-vote/vote requests are retained, at most one per current-campaign voting peer. They expire at
the existing connect timeout, capped at 10s, and are discarded on campaign, role, term, membership or address changes.
The post-Ready loop retries only over an already registered connection, after persistence; its existing 100ms tick
guarantees progress when otherwise idle. It does not create connection retries, await a peer or queue ordinary Raft
traffic. Full/closed channels retain the existing lossy/backpressure behavior. This preserves Raft safety while avoiding
an unnecessary extra election round when a healthy peer connection becomes ready.

CI retains `election-baseline.log` and `election-patched.log` alongside the existing storage proof. Both native
architectures must still pass the unchanged delayed-message, 38s-pause and sub-100s node-loss fixture. No production
configuration, election timer or acceptance deadline is relaxed.

`docker build services/restate` builds the production server. Release and cluster verification instructions belong in
the [application runbook](../../argocd/applications/restate/README.md). Never run fault injection against the live cluster.

CI uploads each tested platform image through `packages/scripts/src/shared/docker.ts push`. Transient registry errors,
including response-header timeouts, get up to three attempts with 15-second and 30-second backoffs. Each attempt uses
the same preparation tag. Authentication errors and exhausted retries fail the job, so the release index and Kargo
tag remain gated on both successful platform uploads.
