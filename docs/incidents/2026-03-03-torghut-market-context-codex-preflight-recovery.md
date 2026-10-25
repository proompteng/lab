# Incident Report: Torghut Market-Context Recovery After Codex Payload/Preflight Failures

- **Date**: 2026-03-03 (UTC)
- **Severity**: High
- **Services affected**: `agents` (`codex-spark` provider), `jangar` market-context dispatch/ingest path, `torghut` market-context dependency

## Impact

- Market-context provider runs were dispatched but intermittently failed before or during lifecycle execution.
- `fundamentals`/`news` snapshots were missing or stale for affected symbols, keeping market-context health degraded.
- Torghut runtime remained live (`running=true`, `kill_switch_enabled=false`) but continued market-closed/no-signal posture during the incident window.

## User-visible Symptoms

- `GET /api/torghut/market-context/providers/<domain>?symbol=<symbol>` returned `snapshotState=missing|stale` with `dispatch_queued` / `dispatch_stuck` risk flags.
- Agent job logs showed hard failure:
  - `OSError: [Errno 30] Read-only file system: '/workspace/run.json'`
- Earlier codex runs in this recovery window also showed prompt/runtime-input mismatch behavior (asking for lifecycle inputs instead of consuming event parameters).

## Timeline (UTC)

- **2026-03-03 04:19:58**: Fresh NVDA market-context runs dispatched (`torghut-market-context-fundamentals-vm25s`, `torghut-market-context-news-qml4f`).
- **2026-03-03 04:20:26-04:20:28**: NVDA AgentRuns entered `Running`.
- **2026-03-03 04:21**: Health remained degraded; fundamentals still missing despite successful run completion signal.
- **2026-03-03 04:25:58**: Merged [PR #3883](https://github.com/proompteng/lab/pull/3883) (`a66a03b1`) to export scalar event parameters in `codex-implement` (long-term image fix).
- **2026-03-03 04:27:58**: Merged [PR #3884](https://github.com/proompteng/lab/pull/3884) (`7d7517cc`) to hydrate prompt placeholders from `run.json.parameters` in the `codex-spark` wrapper.
- **2026-03-03 04:29:25-04:29:27**: New runs (`...fundamentals-9zps2`, `...news-lt9jd`) failed immediately with read-only filesystem traceback writing `/workspace/run.json`.
- **2026-03-03 04:30:28**: Merged [PR #3885](https://github.com/proompteng/lab/pull/3885) (`f8c013d5`) to copy event payload to writable `/tmp/codex-event.*.json` before preflight mutation.
- **2026-03-03 ~04:31**: Argo `agents` synced to `f8c013d510a5a9bf35cf67e23bef3ec2a2a1bb98` (Healthy/Synced).
- **2026-03-03 04:32:22-04:33:23**: AMZN fundamentals/news runs succeeded; snapshots persisted for both domains.
- **2026-03-03 04:35:27**: Merged [PR #3886](https://github.com/proompteng/lab/pull/3886) (`9ae4b565`) promoting Jangar image with `#3883` runtime fix.
- **2026-03-03 04:35:50-04:36:51**: NVDA news run succeeded and persisted fresh snapshot.
- **2026-03-03 04:38:43-04:40:18**: NVDA fundamentals rerun completed with fresh snapshot persisted.

## Root Causes

1. **Prompt placeholder hydration gap in provider wrapper**
   - Implementation text uses `${symbol}`, `${callbackUrl}`, `${requestId}`, etc.
   - Event payload values were nested under `parameters`; placeholders were not hydrated before codex execution.

2. **Preflight mutation attempted on read-only mounted payload**
   - Wrapper script wrote directly to `/workspace/run.json` (ConfigMap mount), causing `Errno 30` and immediate job failure.

3. **Runtime environment export gap (long-term hardening)**
   - `codex-implement` did not export arbitrary scalar event parameters to env by default, reducing compatibility with shell-driven ImplementationSpec workflows.

4. **Stale dispatch state/cooldown after failed attempts**
   - Failed `submitted` state could hold subsequent provider calls in cooldown until state aged out or was reset.

## Recovery Actions

1. Added runtime hardening in Jangar codex runner ([PR #3883](https://github.com/proompteng/lab/pull/3883)):
   - Export event scalars into env and `CODEX_PARAM_*` aliases.
   - Added regression test coverage.
2. Added immediate GitOps wrapper hydration ([PR #3884](https://github.com/proompteng/lab/pull/3884)):
   - Hydrate top-level fields from `parameters` and interpolate placeholders in `prompt`/`issueBody`/`implementation.text`.
3. Fixed read-only preflight failure ([PR #3885](https://github.com/proompteng/lab/pull/3885)):
   - Copy run payload to writable `/tmp` file before mutation and pass temp file to `codex-implement`.
4. Promoted Jangar image with runtime fix ([PR #3886](https://github.com/proompteng/lab/pull/3886)).
5. Cleared stale NVDA fundamentals dispatch-state row to unblock immediate rerun.

## Validation Evidence

- Argo app `agents` synced/healthy at `f8c013d510a5a9bf35cf67e23bef3ec2a2a1bb98`.
- Failed job signatures eliminated after wrapper temp-file fix; fresh runs complete.
- Jangar DB (`public.torghut_market_context_snapshots`) fresh rows confirmed:
  - `AMZN fundamentals` (`quality_score=0.84`) and `AMZN news` (`0.77`)
  - `NVDA fundamentals` (`0.87`) and `NVDA news` (`0.78`)
- Provider endpoints return `snapshotState=fresh` for recovered symbols.
- Torghut status remains operational: `running=true`, `kill_switch_enabled=false`, `last_error=null`.

## Residual Notes

- One NVDA fundamentals lifecycle row (`request_id=a8621b6d-7fa2-49b5-9d4c-acfd66372d27`) remained in `status=started` despite finalized snapshot persistence, indicating lifecycle-state reconciliation can still be improved.

## Follow-up Actions

1. Add integration test coverage that provider preflight never mutates read-only mounted payload paths.
2. Add lifecycle reconciliation to mark `torghut_market_context_runs` terminal status when finalize succeeds but start/progress partially fail.
3. Add an operator-safe dispatch-state reset/override path (symbol+domain scoped) for incident response.
4. Execute market-open verification checklist to confirm post-open signal flow and live trade continuity after this recovery window.
