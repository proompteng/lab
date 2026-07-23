# Buzz relay Ceph RGW compatibility image

This derivative image keeps the upstream Buzz `v0.4.23` runtime and replaces
only `buzz-relay` with a binary built from upstream revision
`acfbb1bb6af54cb29cb152496ff43b8285dcb8cf` plus
[`ceph-rgw.patch`](./ceph-rgw.patch).

The patch is intentionally opt-in through
`BUZZ_GIT_S3_COMPATIBILITY=ceph-rgw`. It:

- removes one matching pair of HTTP quotes from an ETag only at the Ceph RGW
  `If-Match` request boundary;
- recognizes only `409` responses whose XML code is
  `ConditionalRequestConflict` (Amazon S3) or `ConcurrentModification` (Ceph
  RGW) as a lost compare-and-swap race;
- preserves fail-closed handling for every unrelated `409`;
- leaves standard S3 and MinIO behavior unchanged when the setting is absent.

## Evidence

Against the production Ceph Squid `19.2.4` RGW, a fresh quoted ETag returned
`412`, the same ETag without outer quotes returned `200`, and a 32-writer
unquoted `If-Match` race produced exactly one `200` plus 31
`409 ConcurrentModification` responses. The final object matched the winning
payload. Amazon S3 documents `409 ConditionalRequestConflict` as a possible
conditional-write conflict, so Buzz must distinguish that semantic response
from unrelated `409` errors.

The build workflow checks out the exact upstream revision, verifies and applies
the patch, runs the focused relay tests, builds on native amd64 and arm64
runners, pins each build to the matching upstream platform-manifest digest, and
publishes one multi-architecture image. The deployment consumes that image by
digest. Remove this derivative after upstream ships equivalent Ceph RGW
compatibility.
