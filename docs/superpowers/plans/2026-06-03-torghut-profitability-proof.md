# Torghut Profitability Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove Torghut can produce at least `$500/day` post-cost profitability from source-linked live-paper/runtime-ledger evidence, then promote only through existing GitOps gates.

**Architecture:** Keep readiness, promotion, and profitability proof separate. Remove false evidence-collection blockers, run bounded SIM/live-paper collection through real sessions, import runtime windows after settlement, assemble a proof packet, and only mark completion when live runtime-ledger readback shows source decisions, executions, fills, TCA/cost refs, closed trips or flat positions, and promotion authority.

**Tech Stack:** FastAPI, SQLAlchemy, Torghut runtime-ledger models, `services/torghut/scripts/renew_latest_empirical_promotion_jobs.py`, `scripts/assemble_runtime_ledger_proof_packet.py`, GitHub Actions, Argo CD, Knative, TigerBeetle.

---

### Task 1: Remove False SIM Audit Blocker

**Files:**
- Modify: `services/torghut/app/main.py`
- Modify: `services/torghut/tests/test_trading_api.py`

- [x] Add tests proving live-mode paper-route endpoints enable read-only `TORGHUT_SIM` target-account audit for explicit SIM/paper evidence targets.
- [x] Add a negative test proving non-SIM/live targets still keep the audit disabled.
- [x] Replace the coarse `settings.trading_mode == "paper"` predicate with a helper that allows audit only for paper mode or explicit SIM evidence plans.
- [x] Run `uv run --frozen pytest tests/test_trading_api.py -k 'target_account_audit or paper_route_evidence'`.

### Task 2: Runtime Window Collection Readiness

**Files:**
- Inspect: `services/torghut/app/trading/paper_route_evidence.py`
- Inspect: `services/torghut/scripts/renew_latest_empirical_promotion_jobs.py`
- Inspect: `argocd/applications/torghut/*paper*runtime*`

- [ ] Re-read `/trading/paper-route-evidence` after the market session opens.
- [ ] Verify `paper_route_session_window_not_open` clears during the session.
- [ ] Verify target-account audit produces clean-window state instead of `paper_route_target_account_audit_unavailable`.
- [ ] If clean-window audit still blocks, patch the exact readback path with a regression test.

### Task 3: Post-Session Import And Proof Packet

**Files:**
- Inspect: `services/torghut/scripts/renew_latest_empirical_promotion_jobs.py`
- Inspect: `services/torghut/scripts/assemble_runtime_ledger_proof_packet.py`

- [ ] After `2026-06-03T21:00:00Z`, run the runtime-window import from the paper-route target plan with exclusive target-plan flags.
- [ ] Assemble the runtime-ledger proof packet from `/readyz`, `/trading/status`, `/trading/paper-route-evidence`, and runtime-window import output.
- [ ] Verify blockers for `source_decisions_missing`, `source_executions_missing`, `source_tca_missing`, `closed_round_trip_missing`, `unclosed_position`, and `runtime_ledger_source_materialization_missing`.
- [ ] Patch the highest-current blocker with a regression test; do not weaken promotion gates.

### Task 4: Promotion And Live Verification

**Files:**
- Modify only the files required by the blocker found in Task 3.

- [ ] Run `uv sync --frozen --extra dev`.
- [ ] Run targeted pytest for touched files.
- [ ] Run all three Torghut pyright profiles.
- [ ] Push a PR, wait for green CI, merge, release, and verify Argo/Knative/post-deploy.
- [ ] Re-read live proof packet and decide whether the profitability goal is complete or which blocker remains.
