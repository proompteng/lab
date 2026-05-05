# Jangar Control Plane Release Verification - 2026-05-05

Release engineer: Marco Silva
Swarm: jangar-control-plane
Branch: codex/swarm-jangar-control-plane-verify
Base: main

## PRs Touched

- #5376 `fix(torghut): restore live jangar dependency quorum`
  - State: merged at 2026-05-05T09:16:09Z.
  - Final check rollup observed as pass/skipped only.
- #5364 `ci: stabilize agents and jangar checks`
  - State: merged at 2026-05-05T09:21:18Z.
  - Final check rollup observed as pass/skipped only.
- #5387 `fix(torghut): restore rollout readiness`
  - State: merged at 2026-05-05T10:17:03Z.
  - Final check rollup observed as pass/skipped only.
- #5521 `fix(jangar): reconcile swarms from agentrun events`
  - State: merged at 2026-05-05T17:58:26Z.
  - Final check rollup observed as pass/skipped only.
- #5525 `chore(jangar): promote image a1b55322`
  - State: merged at 2026-05-05T18:11:09Z.
  - Final check rollup observed as pass/skipped only.
- #5454 `feat(jangar): surface failure-domain lease holdbacks`
  - State: open.
  - Mergeability: GitHub reported `MERGEABLE` and `CLEAN`.
  - Checks: pass/skipped only.
  - Gate: blocked because the PR is 1,538 additions and 4 deletions, which triggers the >1,000-line Codex review gate.

## Comments And Conflicts

- The selected earlier blockers (#5376, #5364, #5387) are already merged and no longer conflict with main.
- #5454 has no GitHub review threads and no posted reviews by GraphQL (`reviewThreads.totalCount=0`, `reviews.totalCount=0`).
- #5454 has two `@codex review` requests. Both bot responses report Codex code-review usage limits, so the required Codex review has not posted.
- Updated the anchored progress comment on #5454 using `services/jangar/scripts/codex/codex-progress-comment.ts`.

## Merge Outcomes

- No additional squash merge was performed from this verification pass.
- #5454 must not be squash-merged until a Codex review is posted and all resulting review threads are resolved.
- The previously merged Jangar path on main is #5521 followed by #5525, promoting image `a1b55322` with digest
  `sha256:cf398e6ab1dd7cc9df5a99bac655a90678d5acaace5ec7ba5b908ff9ee3d1478`.

## Deployment Evidence

- Kubernetes identity: `system:serviceaccount:agents:agents-sa`.
- GitOps visibility is RBAC-limited:
  - `applications.argoproj.io` in `argocd`: forbidden.
  - `deployments.apps` in `jangar`: forbidden.
  - `pods`, `pods/log`, `services`, and `events` in `jangar`: readable.
- Jangar pod evidence after recovery:
  - Pod: `jangar-584d75f4f6-zt9b2`.
  - Image: `registry.ide-newton.ts.net/lab/jangar@sha256:cf398e6ab1dd7cc9df5a99bac655a90678d5acaace5ec7ba5b908ff9ee3d1478`.
  - Containers: `app ready=true restartCount=3`, `docker ready=true restartCount=0`.
  - Pod conditions: `Ready=True`, `ContainersReady=True`.
  - Health check: `curl http://jangar.jangar.svc.cluster.local/health` returned `{"status":"ok","service":"jangar",...}`.
  - App log: `[jangar] listening on http://0.0.0.0:8080` at 2026-05-05T18:31:25Z.
- Stability recheck at 2026-05-05T18:36Z:
  - `app ready=true restartCount=3`, unchanged from the first recovered observation.
  - `/health` still returned ok.
  - App logs for the prior two minutes were quiet.
- Recent warning events before recovery:
  - `pod/jangar-584d75f4f6-zt9b2`: readiness probe connection refused and app container backoff.
  - `pod/jangar-db-1`: readiness probe returned HTTP 500.
  - Jangar app logs during failed starts showed Postgres `Query read timeout` during Kysely migrations.
- Remaining warning signal at the 18:36Z recheck:
  - `pod/jangar-db-1` still had a recent readiness probe HTTP 500 event, so database health remains a residual risk.

## Risks

- Rollout cannot be fully certified through Argo CD or Deployment rollout APIs from this runner because the available service account lacks RBAC for those resources.
- The live Jangar pod is currently healthy by pod and HTTP evidence, and its restart count stayed stable through the 18:36Z recheck. Recent CNPG readiness warnings mean the gate remains yellow until database health is also quiet.
- #5454 remains blocked on Codex review capacity and must not be merged even though its branch is clean and checks are green.

## Rollback Path

- If the Jangar app becomes unready again after #5525, open a GitOps PR that reverts #5525 image promotions:
  - `argocd/applications/jangar/kustomization.yaml` back to tag `e48d29c9` and digest
    `sha256:f0bec7dfbeea4bbe99c36d9f5a9e327c95bc36e57c0d021bc502e7a603d671aa`.
  - `argocd/applications/agents/values.yaml` back to Jangar tag `e48d29c9`, Jangar digest
    `sha256:f0bec7dfbeea4bbe99c36d9f5a9e327c95bc36e57c0d021bc502e7a603d671aa`, and control-plane digest
    `sha256:65a524641f04d35524cfd86bc035592b5b8696cc0577c33feee8ed62cc5ef39e`.
- If DB readiness failures continue independently of the Jangar app image, treat rollback as insufficient and escalate the CNPG/API-server connectivity path with the event/log evidence above.

## Next Action

- Keep #5454 blocked until Codex review capacity is restored and a review is posted.
- Recheck Jangar pod readiness, `/health`, warning events, and app restart count after the next stability window.
- Request RBAC or an alternate read credential for Argo CD Application and Deployment rollout status if full GitOps certification is required from this runner.
