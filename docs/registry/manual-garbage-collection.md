# Registry cleanup

`registry-cleanup` runs daily at 03:23 America/Los_Angeles. Its controller executes one worker in the existing
`registry-maintenance` container. It uses the existing `registry-data` claim. Cleanup never creates a helper Pod,
restarts the registry, pins a node, or patches an Argo Application or Deployment.

## Retention and storage

The sole retention implementation preserves at least five recent build tags per repository, every image uploaded
within seven days, unknown human tags, and images referenced by the configured workload and retained Kargo resources.
It traverses OCI indexes, platform manifests, attestations and layers. A missing protected object or failed protection
read aborts cleanup. `packages/scripts/src/registry/protected_resources.json` and the list-only RBAC rules name the
exact protection resources. Cleanup does not discover or enumerate unrelated CRDs.

The worker prepares online, requests a fresh protection snapshot, closes the proxy's write gate and drains accepted
uploads. The four-minute frozen budget includes drain, current-root validation and atomic quarantine moves. Reads
remain available. The gate is persisted before closing, so a proxy restart still rejects new mutations. Distribution
binds only to 127.0.0.1:5000; the Service and Ingress continue through the existing proxy on port 8080.

Quarantine moves do not free allocated blocks. The worker reopens uploads before physically deleting quarantined
files. Version 3 receipts bind each batch and directory inode to the original PVC UID/PV. Blob hashes, inode, size and
mtime must still match. Tag inventories preserve every metadata file and directory identity. Changed files, unexpected
entries, symlinks and missing or invalid receipts fail closed. Interrupted purges resume from the receipt. A partial
collection can finish online only if its durable receipt validates.

Pre-version-3 receipts have no deletion authority and remain preserved. Historical recovery evidence is retained;
recovery of such a batch requires a separately reviewed data-restoration plan. The former phase CLIs are removed.

## Run and inspect

Use the GitOps-managed CronJob or run the same controller locally with the intended existing Kubernetes context:

```sh
python3 packages/scripts/src/registry/run.py --context galactic-tailscale
kubectl --context galactic-tailscale -n registry logs job/<job-name> -c cleanup -f
```

Do not overlap manual runs. The worker's exclusive filesystem lock also rejects concurrent cleanup. The controller
and worker verify their script hashes, the exact ready Pod and the Bound claim. Progress events appear as work happens,
including prepare, the protection refresh, upload fencing, quarantine, upload restoration, purge and completion.

The CronJob retains its two-hour deadline and has no automatic retry. Online preparation allows 45 minutes and each
online purge allows one hour. The 60-second shutdown grace lets the controller stop its exact native worker. Queued
filesystem tasks are canceled, active tasks stop before writes reopen, and durable receipts survive interruption.
A timeout or protection failure still fails the Job. Do not mark it successful or remove failed history to change health.

After a completed cleanup, verify the CronJob's `lastSuccessfulTime`, Argo health, protected-image availability, a fresh
push and a full pull with matching content. Check actual free space without changing the claim or deleting live blobs.

## Recover an interrupted worker

The controller normally stops its native worker and reopens uploads. If worker termination cannot be confirmed,
writes remain fenced. Keep reads available and inspect the exact registry Pod and the JSON owner record at
`/control/worker.json`. The record binds its run ID, PID and process start time. Never signal a different process generation.

To resume normal cleanup, start the current controller after the previous Job has stopped. Acquiring the worker's lock
proves the previous cleanup worker cannot still mutate the filesystem. The new worker then reopens a stale gate and
resumes valid receipted purges before preparing. Do not manually clear the gate while a worker may still be active.
A proxy container restart reloads the persisted gate. A registry Pod replacement stops both serving and cleanup
processes through the existing Recreate lifecycle; its control volume is private to that Pod.

## Validate changes

```sh
bun test packages/scripts/src/registry/__tests__/cleanup.test.ts
python3 -m unittest discover -s packages/scripts/src/registry -p 'test_*.py'
docker build -f argocd/applications/registry/tests/cleanup.Dockerfile -t registry-cleanup-test .
docker run --rm --network none --read-only --cap-drop ALL --tmpfs /tmp \
  --tmpfs /control:uid=99,gid=99,mode=0770 \
  --tmpfs /var/lib/registry:uid=99,gid=99,mode=0770 \
  --memory 256m --cpus 2 --pids-limit 128 registry-cleanup-test
```

The real HAProxy fixture checks stalled-upload drain, reads during quarantine, mutation rejection, proxy restart while
frozen, exception recovery, actual retention and purge, and recovery after a killed worker. The separate upload-pacing
fixture preserves the shared 10 MiB/s boundary. The scoped `registry-cleanup` workflow runs both fixtures in CI.
Render the registry Application and validate its resources before delivering through reviewed `main` and Argo.
