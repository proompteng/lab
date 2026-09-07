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

The primary identity is exclusively a disposable test account. All content and processes inside a canary belong to the acceptance run. Never use it for development or interactive work. The two stages share this identity and one workflow concurrency group.

A new agent is created with a generated `tengri-acceptance-` display name. A local, fsynced v3 lease records the exact agent ID, creation timestamp, display name, MicroVM UID, and nested test resources. The owner fingerprint is derived from the authenticated BFF user ID, so normal cookie rotation does not invalidate the lease. Old v2 cookie-bound local leases are rejected and require operator review.

In GitHub Actions, the command publishes an immutable creation lease immediately after obtaining the new MicroVM UID, before any file, terminal, or preview checks. It requests 90-day retention; repository retention settings can shorten this. The lease contains only the owner fingerprint, generated canary identity, and source workflow run/attempt metadata. It never contains a cookie, raw user ID, guest content, or authentication ticket. The workflow uses the pinned `@actions/artifact` client through a JavaScript action, which passes the runner's artifact credentials to the command without persisting them. Cross-run downloads use the built-in job token with `actions: read`. See the [GitHub artifact client contract](https://github.com/actions/toolkit/tree/main/packages/artifact) and [artifact retention rules](https://github.com/actions/upload-artifact#retention-period).

Before a later run creates anything, it checks the newest trusted creation lease for that owner across both Kargo stages. The artifact digest, repository, workflow path, branch/event, source revision, and exact run attempt must agree. It never falls back to an older lease when the newest trusted record is expired, corrupt, or unverifiable.

A prior `cancelled` or `timed_out` run can be recovered automatically: the BFF owner, agent creation timestamp, display name, MicroVM UID, and child owner references must still match. The command then deletes that exact disposable canary through the BFF and waits for its MicroVM, Pod, and PVC to disappear before reusing the owner's deterministic agent name. It uses a fresh workload baseline rather than an earlier release's configuration. If a previous delete already removed the MicroVM, the next run still waits for its Pod and PVC garbage collection. A completed failure, a lost runner reported as `failure`, an unexpected incarnation, or an existing agent without a durable creation lease requires operator review. This preserves canaries deliberately retained after a safety failure.

Within a run, cleanup verifies the file hash and incarnation before removing recorded preview sessions, terminal, acceptance file, and agent. Unexpected file content, a missing/unreadable file, or a changed incarnation stops cleanup. The dedicated account contract gives the run ownership of the entire disposable guest; these file checks are conservative diagnostics, not a general filesystem writer fence. Other user workspaces are never selected by display name or prefix. Kubernetes inspection is read-only and does not read Secrets.

Two interruption boundaries require manual review: termination between successful agent creation and finalization of its first artifact, and loss/expiry of the stored artifact. The local creation identity remains available for cleanup when a normal upload error is caught, and no guest checks start after a failed upload. A process killed before that cleanup cannot safely infer ownership on its next run. Inspect the retained creation receipt and the exact BFF/MicroVM incarnation, then explicitly delete the dedicated canary through its normal product UI; do not delete a different user's agent or an unmatched incarnation.

## Workflow and local execution

`.github/workflows/tengri-post-deploy.yml` runs on Kargo branch pushes only:

- `kargo/tengri` or `kargo/proompteng`;
- changes under `argocd/applications/tengri/**` or `argocd/applications/proompteng/**`.

It has one global concurrency group, `cancel-in-progress: false`, covering both stages. `workflow_dispatch` runs only from `main`, requires an explicit stage and full expected revision, and is diagnostic only. It does not replace the Kargo promotion path or perform deployment mutations.

After the Kubernetes identity preflight, the command is:

```bash
bun run packages/scripts/src/tengri/acceptance.ts \
  --stage tengri \
  --expected-revision <full-kargo-branch-sha>
```

For a local run, set both cookie variables, `TENGRI_ACCEPTANCE_OUTPUT`, and an isolated `TENGRI_ACCEPTANCE_LEASE_FILE`. The default base URL is `https://proompteng.ai`; only HTTPS origins are accepted outside localhost. The command uses read-only Kubernetes queries for provenance, delivery, runtime inspection, and cleanup verification. BFF actions are limited to the owned canary and its recorded file, terminal, and preview resources.

## Runner permissions

The proposed permissions are defined in `argocd/applications/agents-ci/runner-rbac-tengri.yaml` and the acceptance job. They must be approved and delivered through GitOps before enabling the canary. The ARC service account `arc:arc-arm64-gha-rs-kube-mode` needs these reads before the first canary is created:

- `get` the named `tengri` and `proompteng` resources of `stages.kargo.akuity.io` in `lab-delivery`;
- `list,get` `microvms.runtime.proompteng.ai` in `tengri`;
- `get` `persistentvolumeclaims` in `tengri`; and
- existing `get/list` access for the selected Pods and Deployments, plus `get` access for the named Argo Applications.

The job also requires GitHub `actions: read` for cross-run artifact verification; it does not require `actions: write` or a personal access token. The command does not require Secret read access. The workflow runs `kubectl auth whoami` before invoking it and fails if the in-cluster identity or any required read is unavailable.

## Evidence

The uploaded `evidence.json` contains the selected stage revision, source revision, Kargo Freight name, immutable image digests, Argo revisions, workload counts/fingerprints, generated canary identifiers, file size/revision/content hash, MicroVM/Pod/PVC UIDs, and check statuses. It does not contain cookies, tokens, authentication headers, PII, guest file contents, terminal output, or raw response bodies. A run is accepted only when all core checks and owned-resource cleanup pass; unavailable credentials or an unavailable core endpoint are visible failures rather than skipped checks.

The command writes an initial `running`/`incomplete` checkpoint before any canary mutation and refreshes it after the major checks, so a runner interruption leaves the latest redacted receipt available for diagnosis.
