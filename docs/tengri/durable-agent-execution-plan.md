# Tengri durable agent execution

Production acceptance passed on 2026-10-25 for source `4523865de9a8178826b60322086a43b47918eba7`.
The exact four-image cohort is deployed through Kargo and Argo, with guest API 8, native Codex 0.164.0,
and Restate service revision 7. Authenticated checks passed in the owner's built-in browser, including
replacement of both original workers during one foreground command. The original home, native history,
saved login, and authorization policy remain intact. Normal publication is restored and automatic sleep is 60 minutes.

This closes the implementation and production acceptance work identified in
[the research](durable-agent-execution-research.md). [The audit](../../.audit/tengri-durable-execution.tsv)
retains failed attempts and earlier releases separately. Runtime source and GitOps define current behavior;
the observations below are dated evidence for this release.

## Execution contract

Restate owns accepted orchestration. Ofz and shared SQL retain authority and generation fences. Nanoagent owns
interaction with the exact native Codex process. There is one dispatch path and no competing SQL run scheduler.

The identities are run ID, operation ID, workspace UID, runtime epoch, thread ID, turn ID, and approval ID.
Lost responses retain the operation and its original input. Native Codex persists `userMessage.clientId`,
allowing acceptance correlation through metadata-only history pages. An ambiguous dispatch is reconciled
before another effect is issued. History alone cannot prove that an interrupted process stopped.

Signed admission enters retryable workspace handlers before a private run or control workflow is allocated.
Rejected old-key envelopes do not consume an operation UUID. Accepted work retains the original journal and
native generation across retries. A newer signed Stop may refresh authority after login or explicit sleep;
an older delayed context cannot overwrite it.

The run acquires its sleep fence before guest preparation. Preparation and dispatch are separate durable steps.
Exact native terminal evidence releases the fence. Cancellation requires the version 2 terminal receipt with
`processesStopped: true`, including cleanup of that turn's owned background terminals. UI completion without
cleanup evidence keeps cancellation pending.

Status reads retain a two-second signed admission lifetime and allow five seconds for an accepted response.
Read recovery has one total fifteen-second budget shared by active lookup and snapshot. Each transient retry
signs a new query. Admission expiry uses HTTP 408; signature and authority denials fail immediately.
This recovery does not replay submissions or controls. Power settings re-fetch the MicroVM after authorization,
verify its UID, owner, and runtime epoch, then patch against its current Kubernetes revision.

An arbitrary shell or browser action is not made transactional by a workflow wrapper. Authoritative readback
or an explicit uncertain outcome remains necessary when an external effect cannot be proved.

## Workspace experience

[The OpenCode source study](opencode-ui-patterns.md) records the inspected revision and applied mechanisms.
Native thread metadata is authoritative for the session list. Archive and Restore require native acknowledgement.
Browser state retains tabs, pins, and selection; per-chat drafts survive navigation in memory. It does not maintain
a competing chat index. Historical archive notifications refresh the native index without clearing a restored
selection. Only the acknowledged Archive action changes the current chat.

Native completion is reconciled with the exact run and client operation when history, acknowledgement, or the
Restate receipt arrives late. Completion clears Thinking and Stop for that turn. It cannot clear another live
turn or bypass cancellation cleanup. Composer focus and newer drafts survive submission. Sidebar navigation
remains available during pending and running work. Human and agent messages have distinct vertical spacing.

Conversation hydration uses skeletons and paginated native turns/items with `excludeTurns: true`. Developer
deprecation notices do not become product alerts. The send control remains unambiguous. Folder previews use
signed `StatFile` metadata before reading contents. Opening a file does not enumerate its siblings. Directories
support child/parent navigation, tabs, and pins. Ordinary repository tools execute inside the owner's VM;
thread start and resume disable external shared app tools that could carry another subject's repository session.

The protocol contract is guest API 8; signed Ofz guest requests remain protocol 4. The operation inventory
compares the BFF, controller, and guest versions and fails CI on a mismatch. Incompatible controller versions
are rejected before signed workspace effects are dispatched.

## Reviewed source and exact release

[PR #15362](https://github.com/proompteng/lab/pull/15362) fixes bounded read recovery and the post-authorization
settings revision race. Both targeted regressions failed before the fix and passed afterward. Validation included
237 controller tests, 48 environment or child-process skips, Clippy, formatting, all four component gates, and
both automatic reviews before merge. [PR #15363](https://github.com/proompteng/lab/pull/15363) removes one
archive-notification selection reset. Its new browser regression failed before the fix; four focused browser
cases, 436 web unit tests with 3,416 assertions, types, lint, formatting, both affected component gates, and
both automatic reviews passed before merge. Earlier implementation and protocol fixes are recorded in the audit.

All four exact-source main workflows passed: native `40155267137`, Ofz `40155267173`, web `40155267163`,
and desktop `40155267144`. Qualification completed on attempt 1. The original native and web publisher jobs
were rerun on attempt 2 to release their unchanged immutable indexes after retained-home preparation.
No operator-created alias, digest bump, or worktree deployment substituted for publication.

| Image      | Deployed index digest                                                     |
| ---------- | ------------------------------------------------------------------------- |
| Tengri     | `sha256:0353b5ecfb5a2acc2202b70c0a018cb1b7d88a4afe5a4743e15ad219e756fc8d` |
| Nanoagent  | `sha256:030cf023e3ff379589130ac80d1d1f90809f86580078a4c4dc0372c22264b540` |
| Ofz        | `sha256:4281bf6e85e3479e2094300428a2f8a55f8eecf4e2ced1956d125f82a2567788` |
| Proompteng | `sha256:262ed0de4014a52c25f3c68263041a768ba99a5f5ad8ccc044c1cc756896b13b` |

All images name source `4523865d` and schema `a0e81e7a9e92a191cbe80b79ddda7019ae2aaac7a90173f83515a2e82256bb9f`.
Freight `8c24f0a08f87de7d1a24a24fcb50731b2d813b3a` produced Ofz GitOps commit
`f437d812915903269209b29ee338ac5ae4bb1f0b`, Tengri `6672caa202debc1e64fa7562872ea0b22567e6f7`,
and Proompteng `15efa342f3a6a76e0426f11ba77a711a018245e5`. All three promotions are Verified and
their Argo Applications Synced and Healthy. Running child digests and SPIRE registrations were checked.
Restate deployment `dp_12vC9IBY1vvZuVsalRjvrYR` registers all three services at revision 7.

## Retained home and identity

The original MicroVM UID is `a8cd3a6e-9e60-4ed3-98e3-a080d35a457f`, Lease UID
`9bdc053c-cd84-42c6-8403-7ef8e37fb56a`, and 32 GiB home PVC UID
`bb8ec4a4-fbfe-453e-b70a-a3f44d23d464`. The filesystem UUID remains
`8d55d060-5ed0-4d13-ab0c-978b15b982e1`. Six continuity file hashes and native history inode `1842945`
matched after cold preparation and again through the authenticated guest Terminal after final Sleep/Resume.

The installed authorization policy hash remains
`2fcbcce4779cfb95afeb338a8e51e2092be5c780941b2f082a4ca6e5e82e708a`. Ofz bootstrap and activation
replayed their original receipts without changing recovery generation or authority. The existing saved
1Password passkey and native login remain usable. No credential or private operation payload was copied into evidence.

See [the retained-home procedure](operations.md#replacing-a-claimed-guest-while-retaining-its-home).
Normal automatic Sleep's exact `idle-sleep/<runtime epoch>` reservation is accepted only after stopped-writer
and drained-invocation checks. Prepared vacant slots require the unchanged allocation, positive snapshot
generation, and no VMM or native runtime claimant. Retire only the stopped exact Pod with UID/resourceVersion
preconditions and normal grace; preserve the home and allocation. Never restore older memory against an advanced home.

## Exact-source production acceptance

These checks used the owner's signed-in built-in browser on the deployed `4523865d` release. They establish
product behavior separately from image qualification and workload health.

| Boundary                   | Observed result                                                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send and completion        | Actual reply, terminal Ready, composer focus retained, and a newer draft typed without refocusing.                                                                                                                                                                                                   |
| Navigation and hydration   | Sidebar/New and return during pending work preserved the draft; loading skeleton rendered.                                                                                                                                                                                                           |
| Archive                    | Native Archive/Restore completed; the restored chat stayed selected automatically after reload. Only the disposable probe was archived afterward.                                                                                                                                                    |
| Resources and native tools | VM-local Git created an empty main-branch repository as nanoagent; folder children and file contents rendered; two pins and three tabs survived reload. Original Chat-only layout and user selection were restored.                                                                                  |
| Worker recovery            | Run `840d7a6b-4ede-4d32-8ec9-65793410290e`, invocation `inv_1jqihHbNmts90svs6rDOzRBzIrU13Ex4ZR`, retained the same deployment and journal after both original worker UIDs were replaced sequentially. New journal commands followed both replacements.                                               |
| Effect identity            | Foreground PID `1100`, start ticks `101625`, and native generation matched before and after worker replacement. One unconditional fsynced append remained exactly one.                                                                                                                               |
| Active-run sleep           | Actual one-minute setting saved; the same Ready VM and run pin survived beyond the configured deadline plus 60 seconds. Current activity extended the effective deadline, so this alone does not isolate the pin as the cause. The focused unit regression covers that branch.                       |
| Stop                       | One actual UI Stop before the 300-second test deadline produced Restate Cancelled and the exact native v2 interrupted/processesStopped receipt. Original PID was gone, append count one, run pin released, UI Ready.                                                                                 |
| Approval                   | Run `86db8471-e82c-4351-bf4b-bd88addc8011` retained turn `01a17132-66a0-7302-9dd7-8e435c51dcc2` and approval `758b53cc6e33ec17661cf2e5cf6a3adb:0` across reload. One Approve once click increased the existing counter from 3 to 4; Succeeded and Ready followed. No counter reset or policy change. |
| Native recovery            | Same-user app-server PIDfd SIGTERM replaced PID `813`/start `3987` with `1151`/start `125561`. The same thread produced `TENGRI_NATIVE_RESTART_452386_OK` and reached Ready.                                                                                                                         |
| Sleep/Resume               | Authenticated Sleep left the sleeping journal and no VMM. Resume retained the same VM/Pod/Lease/PVC/filesystem and files, then produced `TENGRI_SLEEP_RESUME_452386_OK` and Ready.                                                                                                                   |
| Restoration                | Saved and read back 60 minutes after the bounded test and after final Resume. No active run remained. Normal publication restored to true after checking for competing native publishers.                                                                                                            |

## Qualification limits

Final native qualification measured AMD64 prepared creation at 596 ms, with resumes of 583, 560, and 542 ms.
ARM64 creation was 666 ms, with resumes of 670, 605, and 545 ms. Both passed the unchanged 1,000 ms limit,
signed metadata and guest-administration checks, and disk-only Sleep with zero resident snapshot bytes and no VMM.
Heartbeat maxima were 0.578 ms on AMD64 and 6.058 ms on ARM64 under the fixture load. Resource diagnostics
were retained outside the timing window.

These measurements cover slot mTLS through real files, PTY, and initialized Codex RPC. Three samples do not
establish a p95. They exclude browser authentication, Kubernetes latency, raw PVC allocation, six concurrent
guests, and fresh-creation distributions. The actual authenticated lifecycle check is separate and is not a
subsecond browser-resume claim. Earlier failed timing artifacts and inconclusive worker trials remain in the audit;
a later successful release does not convert them into passes. Arbitrary external tool effects still require
their own idempotency or reconciliation contract.
