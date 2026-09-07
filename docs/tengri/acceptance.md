# Tengri real guest acceptance

The real guest acceptance command proves the deployed Tengri control plane and Nanoagent image through the production BFF. It runs only after it has bound the run to the exact Kargo promotion and immutable image digests that are serving the cluster.

The core acceptance covers:

- a new disposable guest created through the authenticated BFF;
- the guest's exact Nanoagent digest, MicroVM, `kata-fc` Pod, owner references, and retained block PVC;
- file read and write, including a two-write compare-and-swap conflict where the stale base must return HTTP 409;
- PTY output, reconnect, and command completion using markers that cannot be satisfied by terminal echo;
- preview HTTP and WebSocket forwarding, followed by preview-session revocation;
- a second authenticated identity receiving an owner-boundary rejection;
- sleep and resume with the same PVC UID, a new Pod UID, and workspace content preserved; and
- cleanup of the canary's owned resources while every pre-existing MicroVM image remains unchanged.

The Codex account probe is reported separately. An unavailable or unauthenticated Codex account is recorded as `not_configured`; it does not turn an otherwise complete core run into a fabricated Codex proof. Missing BFF authentication, control-plane access, provenance, delivery, or any core check fails the run.

## Exact deployment binding

For both `tengri` and `proompteng`, the command reads the named Stage in `lab-delivery`, verifies a successful `status.lastPromotion.status.phase`, and extracts the promotion `status.state` and Freight metadata. The source revision comes from the promotion step's `commits["./src"]` value. It then checks all of the following:

- the promotion push branch is exactly `kargo/tengri` or `kargo/proompteng`;
- the promotion commit is the current tip of that Kargo branch;
- each Freight image has an immutable digest and an `org.opencontainers.image.revision` matching the source revision;
- the Kargo branch Kustomization contains the same controller/Nanoagent or Proompteng digest; and
- Argo's Application is `Synced` and `Healthy` at that branch tip, with an observed Deployment generation, updated and ready replicas, and selected non-terminating ready Pods declaring the promoted image and reporting the same promoted OCI index digest. A platform child or config digest is recorded as unverified and fails the run until its ancestry is resolved.

The event's full 40-character revision is required for the selected stage. After the guest checks, both stages and both deliveries are read again. A change in either stage's source, branch commit, Freight, or manifest digest fails the run so a superseded canary cannot be reported as acceptance for the original event.

## Dedicated identities and session setup

The workflow requires two separately authenticated Better Auth identities:

- `TENGRI_AUTH_COOKIE`: the primary disposable-test identity;
- `TENGRI_REJECTION_AUTH_COOKIE`: a second identity used only for owner-boundary rejection.

Each secret contains the complete `Cookie` request-header value captured from an authenticated request to `https://proompteng.ai/api/tengri`. The two snapshots must report different authenticated user IDs. Do not use the existing production user's workspace, invent a GitHub subject, copy an OAuth token, mint a session, or provide internal gRPC signing credentials to the command. All product actions go through the same-origin BFF, which signs the internal control-plane request on behalf of the authenticated user; Kubernetes inspection is read-only.

Reserve both dedicated identities for this workflow while a run is active. Do not start concurrent local runs with the same primary identity; the workflow-wide concurrency group serializes GitHub runs, and an isolated lease file is required for a recovery run.

The current Better Auth session lifetime is seven days with a one-day update age. The command accepts `Set-Cookie` rotation during a run in an in-memory cookie jar. It never writes a rotated cookie back to GitHub or another persistent store. Renew each secret manually through the normal authenticated browser flow before its session expires; unattended lifetime beyond that session TTL is not supported. A missing, expired, or invalid cookie fails during authentication before the command creates or deletes an agent.

## Safety and cleanup

The primary identity must have no visible agents unless the caller supplies the explicit local lease file from an earlier interrupted run. A new agent is created with a generated `tengri-acceptance-` display name, and an atomic lease records the exact agent ID, creation timestamp, MicroVM UID once provisioned, display name, terminal creation ID, cookie fingerprint, file prefix, and any issued preview session IDs. Before cleanup, the command rechecks the authenticated agent creation timestamp and MicroVM UID. A display name or run ID alone never authorizes cleanup of a resource from another run.

The command only removes the resources recorded in that lease. It deletes the preview session, terminal, acceptance file when its current content still matches the recorded SHA-256, and exact canary agent, then waits for the owned MicroVM, Pod, and PVC to disappear. It does not read or delete Secrets. Cleanup also compares the before/after MicroVM image inventory by name and digest. If the file or canary incarnation changed, cleanup stops before agent deletion, retains the lease and canary for operator review, and fails closed. Other cleanup failures likewise retain the lease; the next run requires that lease or an explicit operator cleanup. No pre-existing agent is selected by scanning a name prefix.

## Workflow and local execution

`.github/workflows/tengri-post-deploy.yml` runs on Kargo branch pushes only:

- `kargo/tengri` or `kargo/proompteng`;
- changes under `argocd/applications/tengri/**` or `argocd/applications/proompteng/**`.

It has one global concurrency group, `cancel-in-progress: false`, covering both stages. `workflow_dispatch` requires an explicit stage and full expected revision and is diagnostic only. It does not replace the Kargo promotion path or perform deployment mutations.

After the Kubernetes identity preflight, the command is:

```bash
bun run packages/scripts/src/tengri/acceptance.ts \
  --stage tengri \
  --expected-revision <full-kargo-branch-sha>
```

For a local run, set both cookie variables, `TENGRI_ACCEPTANCE_OUTPUT`, and an isolated `TENGRI_ACCEPTANCE_LEASE_FILE`. The default base URL is `https://proompteng.ai`; only HTTPS origins are accepted outside localhost. The command uses read-only Kubernetes queries for provenance, delivery, runtime inspection, and cleanup verification. BFF actions are limited to the owned canary and its recorded file, terminal, and preview resources.

## Runner permissions

The ARC service account needs the following least-scope reads before the first canary is created:

- `get` the named `tengri` and `proompteng` resources of `stages.kargo.akuity.io` in `lab-delivery`;
- `list,get` `microvms.runtime.proompteng.ai` in `tengri`;
- `get` `persistentvolumeclaims` in `tengri`; and
- existing `get/list` access for the selected Pods and Deployments, plus `get` access for the named Argo Applications.

The command does not require Secret read access. The workflow runs `kubectl auth whoami` before invoking it and fails if the in-cluster identity or any required read is unavailable.

## Evidence

The uploaded `evidence.json` contains the selected stage revision, source revision, Kargo Freight name, immutable image digests, Argo revisions, workload counts/fingerprints, generated canary identifiers, file size/revision/content hash, MicroVM/Pod/PVC UIDs, and check statuses. It does not contain cookies, tokens, authentication headers, PII, guest file contents, terminal output, or raw response bodies. A run is accepted only when all core checks and owned-resource cleanup pass; unavailable credentials or an unavailable core endpoint are visible failures rather than skipped checks.

The command writes an initial `running`/`incomplete` checkpoint before any canary mutation and refreshes it after the major checks, so a runner interruption leaves the latest redacted receipt available for diagnosis.
