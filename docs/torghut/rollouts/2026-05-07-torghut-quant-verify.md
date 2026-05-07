# Torghut quant verifier release gate - 2026-05-07

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-07T15:58:00Z

## Owner update message

Torghut release gate is go at latest main revision
`cd91a811330dbf42c87096f98510e9cdfeab9a3d` (#5903). Current-main Torghut CI is green, the
post-deploy verification workflow is green, and both Argo applications are `Synced` / `Healthy` at
that revision. Live, simulation, options catalog, and options enricher workloads are ready on
Torghut image digest `sha256:a11681083f23a9e0b9255b4e7e5052d812708514c965860a95b70e55958dad34`
with zero restarts.

The websocket promotion from #5887 remains ready on digest
`sha256:2b7ffed234dfa4ce748c0f428e7c5ecb74bd5da29da7dd443f74aa8f96050c5e`. Strategy ConfigMap
changes from #5892 and #5900 are present in-cluster: `intraday-tsmom-profit-v3` and
`breakout-continuation-long-v1` both show `enabled: true`.

The only remaining open Torghut PR in the enumerated set is #5412. It is no-go because the diff is
larger than the 1000-line Codex review threshold and the mandatory Codex review has not posted.

## Open PR enumeration

- #5412, `feat(torghut): add renewal bond profit escrow`, is the only open Torghut PR found after
  the release train settled. It has green or skipped visible checks and no unresolved review
  threads, but it remains blocked by the missing mandatory Codex review for a 6,368-line diff.
- #5887, #5884, #5890, #5892, #5896, #5899, #5900, #5902, and #5903 merged during this release
  watch or immediately before verification completed. The active production gate moved with main
  until #5903 became the latest Torghut promotion.

## PRs touched

- #5887: verified merged websocket image promotion and in-cluster websocket readiness.
- #5884: verified merged route-scoped TCA evidence fix and green Torghut CI.
- #5890: verified Torghut image promotion for source commit `8e3f342e3`, checks, and rollout.
- #5892: verified paper intraday chip sleeve ConfigMap rollout.
- #5896: verified empty route-universe repair merged with green PR checks.
- #5899: verified promotion for source commit `cba0e2a9`; superseded by later Torghut promotions.
- #5900: verified active paper breakout sleeve merged with green PR checks and later image build.
- #5902: verified promotion for source commit `b5c89887`; superseded by #5903 after #5900 built.
- #5903: verified latest promotion for source commit `959051e8`, green checks, and rollout.
- #5412: inspected checks, comments, review state, and diff size; kept the no-go gate explicit.
- This audit branch: refreshed this rollout note and
  `/workspace/.agentrun/swarm/torghut-quant-verify.md`.

## Comments and conflicts resolved

- No selected merged PR had unresolved review threads at the time it merged or was verified.
- #5412 has no unresolved review threads and no posted reviews, but it still lacks the mandatory
  Codex large-diff review.
- Promotion and runtime changes moved through GitHub PRs and Argo CD. I did not mutate production
  workloads directly from the local shell.
- I published live release updates to the general channel through `/usr/local/bin/codex-nats-publish`.

## Merge outcomes

#5887 merged:

- PR: https://github.com/proompteng/lab/pull/5887.
- Title: `fix(torghut): promote equity websocket images`.
- Merge commit: `33493a373b8db76bdca8467073e49200d79925d0`.
- Websocket digest:
  `sha256:2b7ffed234dfa4ce748c0f428e7c5ecb74bd5da29da7dd443f74aa8f96050c5e`.

#5884 merged:

- PR: https://github.com/proompteng/lab/pull/5884.
- Title: `fix(torghut): expose route-scoped tca evidence`.
- Merge commit: `8e3f342e3f31927f016dece75eed0660b9bec280`.

#5890 merged:

- PR: https://github.com/proompteng/lab/pull/5890.
- Title: `chore(torghut): promote image 8e3f342e`.
- Merge commit: `c5b9101f22f57b6251c30ce1c458ddd056e31455`.
- Promoted digest:
  `sha256:9c5c85848ba0b46253f374f7f670fd5d201c043e33a2bc7d85149efc1db3f4b0`.

#5892 merged:

- PR: https://github.com/proompteng/lab/pull/5892.
- Title: `fix(torghut): enable paper intraday chip sleeve`.
- Merge commit: `cba0e2a9406f7a42992d05e8965b6940bb3afa3f`.

#5896 merged:

- PR: https://github.com/proompteng/lab/pull/5896.
- Title: `fix(torghut): gate empty route universe repair`.
- Merge commit: `b5c8988724f1811bfb718d2096178199bac700b4`.
- PR checks were green, including Torghut CI run `25505704244`.

#5899 merged:

- PR: https://github.com/proompteng/lab/pull/5899.
- Title: `chore(torghut): promote image cba0e2a9`.
- Merge commit: `5068d612126bb4040e3a0b382394fa2687daef28`.
- Promoted digest:
  `sha256:46939d0053a17de7aa00ccaebec6a394d3ce4773580ef4c66141d0c72891ecf8`.
- PR checks completed green, including Torghut CI run `25506012587`.

#5900 merged:

- PR: https://github.com/proompteng/lab/pull/5900.
- Title: `fix(torghut): enable active paper breakout sleeve`.
- Merge commit: `959051e8d45d67529dc6a67b399103391d47a31c`.
- PR checks were green. The main-branch CI run was superseded by the later #5903 promotion run.

#5902 merged:

- PR: https://github.com/proompteng/lab/pull/5902.
- Title: `chore(torghut): promote image b5c89887`.
- Merge commit: `dc0fd2ff1591f482e55bbd692793d9cc19aa5cda`.
- Promoted digest:
  `sha256:621d1a08e44e67c33cfbd29595f2ea6f2e3e52bae264a11c0cce6df3caa0576b`.
- PR checks completed green, including Torghut CI run `25506293717`.

#5903 merged:

- PR: https://github.com/proompteng/lab/pull/5903.
- Title: `chore(torghut): promote image 959051e8`.
- Merge commit: `cd91a811330dbf42c87096f98510e9cdfeab9a3d`.
- Promoted digest:
  `sha256:a11681083f23a9e0b9255b4e7e5052d812708514c965860a95b70e55958dad34`.
- PR checks and current-main checks are green. Current-main Torghut CI run `25506627825` passed and
  post-deploy verification run `25506627710` passed.

#5412 remains no-go:

- PR: https://github.com/proompteng/lab/pull/5412.
- Current head: `18f900fe9376a419ecd05732c5f37d40a29a8223`.
- Size: 5,915 additions and 453 deletions across 25 files.
- Visible checks are green or skipped.
- No Codex review is posted, so it must stay unmerged.

## Validation

- PASS: Read the NATS context soak from `.codex-nats-context.json` before action.
- PASS: Published live release updates through `/usr/local/bin/codex-nats-publish --publish-general`.
- PASS: `gh pr list -R proompteng/lab --state open --search 'torghut in:title,body' ...` returned
  #5412 as the only remaining open Torghut PR.
- PASS: `gh pr checks 5903 -R proompteng/lab --watch --interval 10`.
- PASS: `gh run watch 25506627825 -R proompteng/lab --exit-status`.
- PASS: `gh run watch 25506627710 -R proompteng/lab --exit-status`.
- PASS: `gh pr checks 5412 -R proompteng/lab` shows green or skipped visible checks.
- PASS: `kubectl wait application/torghut -n argocd --for=jsonpath='{.status.sync.revision}'=cd91a811330dbf42c87096f98510e9cdfeab9a3d`.
- PASS: `kubectl wait application/torghut-options -n argocd --for=jsonpath='{.status.sync.revision}'=cd91a811330dbf42c87096f98510e9cdfeab9a3d`.
- PASS: `kubectl wait job/torghut-db-migrations -n torghut --for=condition=complete`.
- PASS: `kubectl get application torghut torghut-options -n argocd ...` shows both apps
  `Synced` / `Healthy` at `cd91a811330dbf42c87096f98510e9cdfeab9a3d`.
- PASS: `kubectl get pods -n torghut ...` shows live, sim, catalog, enricher, and websocket pods
  ready with zero restarts.
- PASS: `kubectl get configmap -n torghut torghut-strategy-config ...` shows
  `intraday-tsmom-profit-v3` and `breakout-continuation-long-v1` with `enabled: true`.

## Deployment evidence

Latest #5903 state:

- `torghut`: `Synced` / `Healthy` at revision `cd91a811330dbf42c87096f98510e9cdfeab9a3d`,
  operation phase `Succeeded`, message `successfully synced (no more tasks)`.
- `torghut-options`: `Synced` / `Healthy` at revision `cd91a811330dbf42c87096f98510e9cdfeab9a3d`,
  operation phase `Succeeded`, message `successfully synced (all tasks run)`.
- `torghut-00271-deployment-dd99f7566-kq79r`: Running, containers ready `true,true`, zero restarts,
  digest `sha256:a11681083f23a9e0b9255b4e7e5052d812708514c965860a95b70e55958dad34`.
- `torghut-sim-00371-deployment-8d6db99b-v67m6`: Running, containers ready `true,true`, zero
  restarts, same Torghut digest.
- `torghut-options-catalog-77cd4c7df9-5zrp4`: Running, ready `true`, zero restarts, same Torghut
  digest.
- `torghut-options-enricher-6d9f68f7dd-m2v6q`: Running, ready `true`, zero restarts, same Torghut
  digest.
- `torghut-ws-6556f5bfc8-vhdv4` and `torghut-ws-options-6d9c958dc5-x7dqf`: Running, ready `true`,
  zero restarts, websocket digest
  `sha256:2b7ffed234dfa4ce748c0f428e7c5ecb74bd5da29da7dd443f74aa8f96050c5e`.

Event evidence:

- #5903 created and completed the `torghut-db-migrations` hook on image digest
  `sha256:a11681083f23a9e0b9255b4e7e5052d812708514c965860a95b70e55958dad34`.
- #5903 scaled up the options catalog and enricher replica sets on the same digest.
- Transient startup readiness warnings appeared during the options rollout and cleared; final pods
  are ready with zero restarts.
- Earlier in the release watch, kube-controller-manager pods entered `CrashLoopBackOff` and then
  recovered. The latest #5903 sync and verification completed after recovery.

## Risks

- #5412 remains the primary open code risk and must stay unmerged until the mandatory Codex review
  posts and all resulting threads are resolved.
- #5892 and #5900 intentionally enable paper-only sleeves. Live-money submission remains behind the
  existing gates; continue watching paper behavior and revenue repair evidence.
- Control-plane instability is residual operational risk. It did not block #5903, but recurrence can
  delay future rollout or rollback hooks.
- Recurring ClickHouse multiple-PDB warnings and Flink status update conflicts predate this rollout
  and did not block the verified Torghut workloads.

## Rollback path

- For #5903: open a GitOps PR reverting `cd91a811330dbf42c87096f98510e9cdfeab9a3d`, or restore the
  previous Torghut image digest
  `sha256:621d1a08e44e67c33cfbd29595f2ea6f2e3e52bae264a11c0cce6df3caa0576b` in the Argo manifests,
  then let Argo CD reconcile.
- For #5900: open a GitOps PR reverting `959051e8d45d67529dc6a67b399103391d47a31c`, or set
  `breakout-continuation-long-v1` back to `enabled: false` in
  `argocd/applications/torghut/strategy-configmap.yaml`.
- For #5892: open a GitOps PR reverting `cba0e2a9406f7a42992d05e8965b6940bb3afa3f`, or set
  `intraday-tsmom-profit-v3` back to `enabled: false` in the same ConfigMap manifest.
- For #5412: no rollback is required because it was not merged and no production rollout occurred.

## Next action

Keep #5412 blocked until Codex review posts and all resulting threads are resolved. Continue
watching the paper sleeves and controller-manager stability; if ConfigMap behavior or runtime health
regresses, revert the relevant GitOps commit above.
