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
   controlled rollout. Tempo's current ingesters use `emptyDir`; preserve their Pod identities while reloading the
   corrected configuration through a reviewed container restart procedure. Do not use Tempo's `/shutdown` handler
   as a reload API: it waits for remote flushes and does not itself exit the process.
5. Require successful uploads of the previously failing blocks, stable flush failure counters, healthy rings,
   current metrics queries, and a newly written trace returned by its exact trace ID. Keep Tempo's `OnDelete`
   protection until retained buffers are accounted for and Pod replacement has a verified preservation path.

## Recovery

If TLS or canary validation fails, stop before changing clients. The existing HTTP Service and RGW processes continue
to serve their current users. Keep Tempo's Pods and local buffers. Do not weaken SigV4 checks, delete a bucket, replace
an ingester Pod, or discard an unshipped block to make the rollout appear healthy.

When retiring the proxy, first move every client to an accepted endpoint and verify live writes, then remove the
alias and route through GitOps. Do not remove the shared wildcard certificate or alter the Rook object user.
