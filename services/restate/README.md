# Restate runtime patch

This build retains upstream Restate 1.7.9 and changes metadata write dispatch to the existing background I/O executor.
WAL synchronization, write completion, replication, on-disk format, and upstream tools remain unchanged. The source
archive and build/runtime images are pinned. The production patch is one line; test-only fault injection is absent
from the runtime image.

`docker build --target test services/restate` injects a two-second delay into real WAL `fsync`/`fdatasync` calls in an
isolated metadata store. It requires the unpatched code to fail responsiveness checks, applies the patch, then verifies
timer and TCP responsiveness, successful durable writes, and the stored Raft state after reopening the database.
It also runs the upstream metadata storage tests. The injector must report an actual WAL sync or the proof fails.

`docker build services/restate` builds the production server. Release and cluster verification instructions belong in
the [application runbook](../../argocd/applications/restate/README.md). Never run fault injection against the live cluster.
