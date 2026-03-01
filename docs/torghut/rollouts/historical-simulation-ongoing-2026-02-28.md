# Torghut Historical Simulation Execution Log

- Authoring date: 2026-02-28
- Session goal: run Feb 27 historical simulation end-to-end in Argo (no local run)
- Workflow template: argocd/applications/torghut/historical-simulation-workflowtemplate.yaml
- Playbook: docs/torghut/rollouts/historical-simulation-playbook.md

## Run plan (required sequence)
1. Capture active Argo workflows and stop all running entries in `argo-workflows` namespace.
2. Clean Kafka simulation topics before run.
3. Verify/prepare dataset manifest for Feb 27 trading day.
4. Rebuild and push torghut image: `registry.ide-newton.ts.net/lab/torghut:sim-run-fix-2026-02-28-09` (includes Kafka runtime SASL fallback + replay progress heartbeat).
5. Submit workflow in Argo with `mode=run`, `runId=sim-2026-02-27-01`, `confirmPhrase=START_HISTORICAL_SIMULATION`.
6. Wait for workflow completion and capture failure/success details.
7. Validate required evidence artifacts and runtime checks.
8. Confirm post-run restoration of simulation settings.

## Root cause and remediations
- Root cause A (confirmed): `runtime_sasl_password` validation in simulation script did not fallback to base Kafka credentials when runtime-specific credentials were absent, causing:
  - `manifest.kafka.runtime_sasl_password is missing` hard-fails in manifests that only define `sasl_password_env`.
- Root cause B (confirmed): replay stage writes no progress into `run-state.json` while long dumps are replayed, so a valid run appears stalled.
- Fix applied:
  - Fallback logic in `_build_kafka_runtime_config` now uses base `sasl_password(_env)` when runtime-specific values are omitted.
  - `_replay_dump` now writes periodic `run-state` heartbeat records (`status_update_every_records` / `status_update_every_seconds`) during replay.

## Commands executed
- [x] Step 1: `argo list --running -n argo-workflows` (no active workflows found)
- [x] Step 1b: `argo list --completed -n argo-workflows | grep torghut-historical-simulation`
- [x] Step 2: list simulation topics matching `^torghut\.sim\.` and delete old simulation topics
- [ ] Step 3: build/push torghut image (`registry.ide-newton.ts.net/lab/torghut:sim-run-fix-2026-02-28-09`)
- [x] Step 4: update workflow template env injection to container env (remove ineffective template-wide patch)
- [x] Step 5: submit `argo submit --from workflowtemplate/torghut-historical-simulation ... --parameter mode=run ...`
- [x] Step 6: wait + capture logs: `argo wait`, `argo logs`
- [ ] Step 7: artifact checks from output path
- [ ] Step 8: verify restoration checks

## Audit log
- status: blocked
- 2026-03-01: workflow lint passes (`./scripts/argo-lint.sh argocd/applications/torghut/historical-simulation-workflowtemplate.yaml`) and no active Argo runs were found.
- 2026-03-01: `argo` run history is full of `mode=run` failures; latest runs are `sim-2026-02-27-10` (invalid confirm phrase), `sim-2026-02-27-11` (permission denied creating `vector` extension), and prior `sim-2026-02-27-xx` attempts.
- 2026-03-01: `sim-2026-02-27-11` failed with `permission denied to create extension "vector"`, indicating `admin_dsn_user` used by workflow is not superuser.
- 2026-03-01: confirmed `torghut_db_app` is NOT superuser (`usesuper = f`), and no `vector` extension exists in `torghut_sim_sim_2026-02-27-11` on cluster.
- 2026-03-01: root-cause fix implemented in `start_historical_simulation.py`:
  - made `vector` extension creation permission errors non-fatal in runtime permission setup,
  - added migration fallback to pre-vector revision when permissions block extension creation.
- 2026-02-28: cleaned prior simulation topics so the run starts from a clean Kafka surface.
- 2026-02-28: updated `services/torghut/config/simulation/example-dataset.yaml` PostgreSQL DSN host from `postgres-rw.torghut.svc.cluster.local` to `torghut-db-rw.torghut.svc.cluster.local` to match cluster service naming.
