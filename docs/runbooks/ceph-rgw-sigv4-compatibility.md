# Ceph RGW 20.2.4 and MinIO signing compatibility

Ceph 20.2.4 rejects a present `Content-Type` header when the SigV4 client omits it from `SignedHeaders`. The MinIO HTTP
streaming signer used by Mimir 3.1.2 and Tempo 2.9.0 omits this header. Their S3 writes therefore fail with `403
AccessDenied`, while other clients continue writing. Ceph's [Content-Type correction](https://github.com/ceph/ceph/commit/534308306f216ea3b5997ef3ac5e0af0c61b54aa)
and [Tentacle backport](https://github.com/ceph/ceph/pull/71364) are newer than the deployed stable image.

MinIO's HTTPS path signs `Content-Type`. Use the cluster's existing Traefik TLS termination to reach the same RGW
Service, with the same credentials, buckets, and object paths. Keep `rgw_sigv4_insecure=false`.

## Endpoint and certificate

- S3 endpoint: `rook-ceph-rgw-tls.rook-ceph.svc:443`.
- Kubernetes DNS resolves that ExternalName Service to the ClusterIP-only `traefik-rgw.traefik.svc.cluster.local`.
- TLS server name: `ceph.k8s.proompteng.ai`. This validates the existing Let's Encrypt certificate in
  `rook-ceph/wildcard-k8s-proompteng-ai-tls`; it is an SNI/verification name, not an address the client resolves.
- The IngressRoute matches the internal S3 hostname and preserves the Host header required by SigV4, forwarding to
  `rook-ceph-rgw-objectstore:80`.
- A dedicated `rgws3` listener accepts long uploads without the public ingress's 60-second request-body limit.
  Its port is absent from the external LoadBalancer Service. Public ingress timeouts remain unchanged.
  Traefik drains requests for up to 50 seconds during its own Pod replacement, within the existing 60-second Pod
  grace period; clients must retry any longer request interrupted by that replacement.
  Long-upload acceptance streams bytes continuously for more than 65 seconds. RGW retains Beast's existing
  [65-second timeout while waiting for more data](https://docs.ceph.com/en/tentacle/radosgw/frontends/#request-timeout-ms).

Do not resolve the S3 endpoint through public wildcard DNS or disable certificate verification. Native RGW TLS using
this wildcard certificate would fail Rook's internal Service hostname check; this proxy leaves Rook's management
endpoint intact. Certificate renewal remains owned by the existing cert-manager and reflector configuration.

## Rollout order and acceptance

1. Merge the TLS proxy and Tempo `OnDelete` protection. Let the Rook and observability Applications reconcile.
   Record the two existing Tempo ingester Pod UIDs and verify they remain unchanged. The strategy change must not
   modify the Pod template or restart an ingester.
2. Verify the TLS chain/SAN through the internal endpoint. Exercise the same MinIO versions and options used by
   Mimir and Tempo: create a unique canary bucket, PUT, read back exact bytes, delete the test objects/bucket, and
   confirm absence. Verify an arbitrary unsigned `x-amz-*` header is still rejected. Readiness alone is insufficient.
3. Only after that evidence, deliver the client configuration. Mimir's three S3 blocks use `insecure: false` and
   `http.tls_server_name: ceph.k8s.proompteng.ai`. Tempo's `storage.trace.s3` uses `insecure: false` and
   `tls_server_name: ceph.k8s.proompteng.ai`. Both use the internal endpoint above and the image CA bundle.
4. Mimir retains its PVC-backed WAL and unshipped blocks. Verify their identities and recovered uploads during its
   controlled rollout. Tempo's current ingesters use `emptyDir`; retain three ingesters on distinct nodes and require
   all three to be Ready and ACTIVE before reloading either original container. Preserve both original Pod identities
   through the procedure below. Do not use Tempo's `/shutdown` handler as a reload API: it waits for remote flushes
   and does not itself exit the process.
5. Require successful uploads of the previously failing blocks, stable flush failure counters, healthy rings,
   current metrics queries, and a newly written trace returned by its exact trace ID. Keep Tempo's `OnDelete`
   protection until retained buffers are accounted for and Pod replacement has a verified preservation path.

## Reload one Tempo ingester without replacing its Pod

Use `scripts/cluster-upgrades/tempo-ingester-reload.py`. Its default is a read-only plan:

```sh
python3 scripts/cluster-upgrades/tempo-ingester-reload.py \
  --context galactic-lan --namespace observability \
  --pod observability-tempo-ingester-0 \
  --audit-file /tmp/tempo-ingester-0-reload-plan.json
```

Before execution, record the exact Pod UID, running ingester container ID, and SHA-256 of the desired
`observability-tempo-config` ConfigMap's `tempo.yaml` data. Verify its projection inside the existing Pod and compare
with the desired hash; never print expanded configuration or credential values. Resolve that exact container's host
PID through the container runtime and record its `/proc/<pid>/stat` start-time ticks (field 22) and the node's
`/proc/sys/kernel/random/boot_id`. Recheck the container identity after reading them. Supply these values through
`--expected-pod-uid`, `--expected-container-id`, `--expected-config-sha256`, `--expected-process-start-ticks`, and
`--expected-boot-id`, plus `--execute` and the approved multi-platform utility image:

```text
mirror.gcr.io/library/busybox:1.37.0@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0
```

Pass that image as `--utility-image`. The helper requires `OnDelete`, three Ready ingesters on three distinct nodes,
a matching three-member ACTIVE ring with fresh heartbeats, and one available PDB disruption. It checks the current
container identity and fences the Pod UID/resourceVersion while appending one ephemeral container targeting the
ingester's PID namespace. That container runs as Tempo's UID/GID 1000 with no elevated capabilities. It verifies
PID 1's command, the projected configuration hash, boot ID, and process start-time ticks before sending one SIGTERM.
A container that restarts before the helper attaches has different process identity and is rejected. Kubernetes
restarts the regular container under `restartPolicy: Always`; the Pod and its `emptyDir` persist. No Pod deletion or
forced signal is part of this procedure.

Require the same Pod UID, one clean container restart, Ready state, and restored ring membership. Check new startup
WAL replay and confirm that every recorded failed block reaches the same bucket before proceeding to the other
original ingester. A helper failure or unexpected identity change stops the sequence; do not repeat it blindly or
delete the Pod to recover.

## Recovery

If TLS or canary validation fails, stop before changing clients. The existing HTTP Service and RGW processes continue
to serve their current users. Keep Tempo's Pods and local buffers. Do not weaken SigV4 checks, delete a bucket, replace
an ingester Pod, or discard an unshipped block to make the rollout appear healthy.

When retiring the proxy, first move every client to an accepted endpoint and verify live writes, then remove the
alias and route through GitOps. Do not remove the shared wildcard certificate or alter the Rook object user.
