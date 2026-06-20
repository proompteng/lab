# Torghut Autoresearch Runner CI Single-Job Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 16 visible `Pytest autoresearch runner N` CI jobs with one autoresearch CI job while splitting the 13.6k-line autoresearch test file into maintainable focused files.

**Architecture:** Keep autoresearch tests isolated from the normal Torghut pytest shards, but run them through one dedicated GitHub Actions job using local `pytest-xdist` parallelism inside that runner. Split the monolithic `tests/test_run_whitepaper_autoresearch_profit_target.py` by behavior area into a new `tests/autoresearch_runner/` package with shared helpers and a non-collected base test case.

**Tech Stack:** GitHub Actions, pytest, pytest-xdist, coverage.py, Python 3.11, uv, unittest `TestCase`.

---

## Current State

- `.github/workflows/torghut-ci.yml` excludes `tests/test_run_whitepaper_autoresearch_profit_target.py` from the normal 4 pytest shards.
- The `pytest-autoresearch-runner` job expands to 16 matrix jobs named `Pytest autoresearch runner 0` through `15`.
- The matrix shards collected pytest node ids from one file and assigned them by `cksum(test_id) % 16`.
- Current collection count is `185` tests from `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`.
- The file is `13,613` lines and contains one collected class: `TestRunWhitepaperAutoresearchProfitTarget`.
- The latest observed 16-job PR run completed individual jobs between about `41s` and `3m32s`; that does not justify 16 separate GitHub check rows anymore.

## Target State

- GitHub Actions shows one autoresearch check: `Pytest autoresearch runner`.
- No `Pytest autoresearch runner 0..15` matrix jobs exist.
- `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py` is deleted.
- New autoresearch test files live under `services/torghut/tests/autoresearch_runner/`.
- No new test module exceeds `3,000` lines.
- Autoresearch test collection stays at `185` tests during the split.
- The normal `pytest-shards` job does not duplicate autoresearch tests.
- The aggregate coverage job still downloads all Torghut coverage artifacts and enforces the existing coverage threshold.
- No runtime code, trading behavior, promotion authority, database schema, route contract, or deployment manifest changes.

## Files

- Modify: `.github/workflows/torghut-ci.yml`
- Delete: `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`
- Create: `services/torghut/tests/autoresearch_runner/__init__.py`
- Create: `services/torghut/tests/autoresearch_runner/helpers.py`
- Create: `services/torghut/tests/autoresearch_runner/test_feedback_evidence.py`
- Create: `services/torghut/tests/autoresearch_runner/test_candidate_selection.py`
- Create: `services/torghut/tests/autoresearch_runner/test_cli_preflight_sources.py`
- Create: `services/torghut/tests/autoresearch_runner/test_replay_tape_preview.py`
- Create: `services/torghut/tests/autoresearch_runner/test_runtime_closure.py`
- Create: `services/torghut/tests/autoresearch_runner/test_candidate_board_evidence.py`
- Create: `services/torghut/tests/autoresearch_runner/test_candidate_board_paper_probation.py`
- Create: `services/torghut/tests/autoresearch_runner/test_epoch_persistence_remediation.py`
- Create: `services/torghut/tests/autoresearch_runner/test_real_replay_shards.py`

## Test Split Map

Move these existing methods by line range from `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`:

- `helpers.py`
  - Top-level imports needed by shared helpers.
  - `_FakeSigalrmSignal`, lines `47-60`.
  - `_authoritative_exact_replay_ledger_rows`, lines `63-133`.
  - `_source_jsonl_payload`, lines `136-173`.
  - `_source_from_payload`, lines `176-190`.
  - `_compact_recent_whitepaper_sources`, lines `194-211`.
  - `setUp`, `tearDown`, `_args`, `_source_jsonl_args`, `_coverage_row`, `_candidate_spec`, lines `215-388`, moved into `AutoresearchRunnerTestCase`.
- `test_feedback_evidence.py`
  - Move methods with prefixes `test_ranker_backend_`, `test_candidate_feedback_`, `test_feedback_evidence_`, `test_portfolio_candidate_feedback_`, `test_candidate_quality_`, `test_oracle_policy_`, `test_candidate_spec_contract_`, `test_pre_replay_ranker_`, `test_feedback_risk_profile_`, `test_feedback_shape_prior_`, `test_feedback_scorecard_`, and `test_validation_contract_`.
  - Covers ranker backend preference, feedback loading, persisted feedback reconstruction, candidate quality gates, pre-replay ranker decisions, and feedback penalty/veto helpers.
- `test_candidate_selection.py`
  - Move methods with prefixes `test_candidate_selection_`, `test_active_loss_counter_`, `test_terminal_risk_profile_`, `test_current_code_commit_`, and `test_synthetic_replay_`.
  - Covers candidate selection gates, synthetic priors, active loss counters, terminal risk profile feedback, code commit provenance, and malformed feedback context handling.
- `test_cli_preflight_sources.py`
  - Lines `880-1114`, `4129-4550`, `6242-6447`, and `11616-12076`.
  - Covers CLI parsing, ClickHouse preflight, workflow template behavior, seed recent whitepapers, selection-only mode, source loading, claim compilation, password env handling, and budget handling.
- `test_replay_tape_preview.py`
  - Lines `4552-6240`.
  - Covers replay tape preview, fast replay preview, bounded sim queue, materialized replay tape, and candidate-spec replay.
- `test_runtime_closure.py`
  - Lines `6449-7266`.
  - Covers runtime closure replay, exact replay ledger requirements, proof blocking, proof helper edges, and market-impact source marker fallbacks.
- `test_candidate_board_evidence.py`
  - Move methods with prefixes `test_candidate_board_adds_`, `test_paper_mechanism_contract_`, `test_candidate_board_helpers_`, `test_candidate_sleeve_goal_`, `test_candidate_board_marks_`, `test_candidate_board_fails_`, `test_candidate_board_rejects_`, `test_candidate_board_accepts_`, and `test_candidate_board_separates_`.
  - Covers candidate board metadata, paper mechanism contract prior, sleeve rows, order-type evidence, queue survival, route TCA, alpha decay, and research-rank versus executed-candidate separation.
- `test_candidate_board_paper_probation.py`
  - Move methods with prefixes `test_candidate_board_surfaces_paper_probation_`, `test_candidate_board_paper_probation_`, `test_candidate_board_single_paper_probation_`, `test_candidate_board_runtime_window_`, `test_candidate_universe_`, `test_full_chip_universe_`, `test_rejects_candidate_universe_`, `test_seed_recent_whitepapers_honors_`, `test_best_false_negative_`, `test_seed_recent_whitepapers_diversifies_`, `test_candidate_selection_reserves_`, and `test_seed_recent_whitepapers_dedupes_`.
  - Covers paper probation gates, runtime-window target dedupe, universe constraints, exploration budgets, false-negative tables, and runtime strategy floor reservation.
- `test_epoch_persistence_remediation.py`
  - Lines `10205-11614` plus `10505-10645`.
  - Covers epoch ledgers, paper probation persistence, persistence failure behavior, replay failure summaries, remediation recommendations, next-epoch plan validation, and train-ranker script entrypoints.
- `test_real_replay_shards.py`
  - Lines `3680-3730`, `3970-4067`, and `12078-13613`.
  - Covers real replay evidence, activity count derivation, real replay budget forwarding, child-process timeout handling, worker result handling, failed-shard retry behavior, bounded worker pools, and incomplete sharded replay blocking.

When a test appears to match two groups above, place it in the file named by the more specific behavior. For example, put `test_candidate_board_adds_factor_acceptance_replay_metadata` in `test_candidate_board_evidence.py`, not `test_feedback_evidence.py`.

## Task 1: Create Shared Test Package

**Files:**

- Create: `services/torghut/tests/autoresearch_runner/__init__.py`
- Create: `services/torghut/tests/autoresearch_runner/helpers.py`

- [ ] **Step 1: Create the package marker**

Create `services/torghut/tests/autoresearch_runner/__init__.py`:

```python
"""Autoresearch runner tests split by behavior area."""
```

- [ ] **Step 2: Create the shared helper module**

Create `services/torghut/tests/autoresearch_runner/helpers.py` by moving the shared helpers from the old file. The base class must not start with `Test`, so pytest does not collect it directly. Do not set `__test__ = False` on the base class because subclasses inherit it and pytest can skip collection. Preserve the bodies of `_args`, `_source_jsonl_args`, `_coverage_row`, and `_candidate_spec` exactly from the old class.

```python
class AutoresearchRunnerTestCase(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()
```

Move the method bodies exactly from the old class. Do not rewrite helper behavior in this PR.

- [ ] **Step 3: Run helper import smoke**

Run:

```bash
cd services/torghut
uv run --frozen python - <<'PY'
from tests.autoresearch_runner.helpers import AutoresearchRunnerTestCase, _CHIP_UNIVERSE
print(AutoresearchRunnerTestCase.__name__)
print(len(_CHIP_UNIVERSE) > 0)
PY
```

Expected output:

```text
AutoresearchRunnerTestCase
True
```

## Task 2: Split The Monolithic Test File

**Files:**

- Create all `services/torghut/tests/autoresearch_runner/test_*.py` files listed in the Files section.
- Delete: `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`

- [ ] **Step 1: Move tests without behavior edits**

Each new test module should import the shared base and use a behavior-specific class name:

```python
from __future__ import annotations

from tests.autoresearch_runner.helpers import AutoresearchRunnerTestCase


class TestAutoresearchRunnerCandidateBoard(AutoresearchRunnerTestCase):
    """Candidate board behavior previously covered by the monolithic runner test."""
```

Move existing test method bodies exactly. Keep test names unchanged so historical `-k` filters still work.

- [ ] **Step 2: Keep imports local and explicit**

At the top of each new file, import only what that file uses. Start each file with the common imports it needs:

```python
from __future__ import annotations

from argparse import Namespace
from datetime import date, datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.orm import Session

import scripts.compile_whitepaper_claims as claim_compiler_script
import scripts.run_whitepaper_autoresearch_profit_target as runner
import scripts.train_mlx_autoresearch_ranker as ranker_trainer
```

Remove unused imports with ruff after the move.

- [ ] **Step 3: Verify no old file remains**

Run:

```bash
test ! -f services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py
rg -n "test_run_whitepaper_autoresearch_profit_target" services/torghut/tests .github/workflows/torghut-ci.yml
```

Expected: the `test ! -f` command exits `0`; the `rg` command returns no references after Task 3 updates the workflow.

- [ ] **Step 4: Verify collection parity**

Run:

```bash
cd services/torghut
uv run --frozen pytest --collect-only -q tests/autoresearch_runner | awk '/^tests\/.*::/ {print $1}' | wc -l
```

Expected output:

```text
185
```

## Task 3: Collapse CI To One Autoresearch Job

**Files:**

- Modify: `.github/workflows/torghut-ci.yml`

- [ ] **Step 1: Exclude the new package from normal pytest shards**

Change the normal `pytest-shards` file selection from:

```bash
find tests -name 'test_*.py' ! -path 'tests/test_run_whitepaper_autoresearch_profit_target.py' -print |
```

to:

```bash
find tests -name 'test_*.py' ! -path 'tests/autoresearch_runner/*' -print |
```

This prevents duplicate execution in the normal 4-file pytest shard matrix.

- [ ] **Step 2: Remove the 16-slice matrix**

In `pytest-autoresearch-runner`, delete this matrix block:

```yaml
strategy:
  fail-fast: false
  matrix:
    slice: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
```

Change:

```yaml
name: Pytest autoresearch runner ${{ matrix.slice }}
```

to:

```yaml
name: Pytest autoresearch runner
```

- [ ] **Step 3: Run autoresearch tests in one job with local xdist**

Replace the `Pytest autoresearch runner coverage` step body with:

```yaml
- name: Pytest autoresearch runner coverage
  working-directory: services/torghut
  shell: bash
  env:
    COVERAGE_FILE: .coverage.autoresearch-runner
  run: |
    set -euo pipefail
    collected_count="$(
      uv run --frozen pytest --collect-only -q tests/autoresearch_runner |
        awk '/^tests\/.*::/ {count += 1} END {print count + 0}'
    )"
    printf 'Collected %s autoresearch runner tests\n' "${collected_count}"
    if [ "${collected_count}" -ne 185 ]; then
      echo "Expected 185 autoresearch runner tests after split, got ${collected_count}"
      exit 1
    fi

    uv run --frozen pytest \
      -n auto \
      --dist=worksteal \
      --cov \
      --cov-branch \
      --cov-fail-under=0 \
      --cov-report= \
      tests/autoresearch_runner
```

Keep the job id `pytest-autoresearch-runner` so the aggregate `lint-and-tests` dependency does not need a semantic rename.

- [ ] **Step 4: Collapse the coverage artifact name**

Change the autoresearch coverage upload from:

```yaml
name: torghut-coverage-autoresearch-runner-${{ matrix.slice }}
path: services/torghut/.coverage.autoresearch-runner-${{ matrix.slice }}*
```

to:

```yaml
name: torghut-coverage-autoresearch-runner
path: services/torghut/.coverage.autoresearch-runner*
```

The aggregate coverage job already downloads `torghut-coverage-*`, so it will continue to pick up this artifact.

## Task 4: Local Validation

**Files:**

- Validate: `.github/workflows/torghut-ci.yml`
- Validate: `services/torghut/tests/autoresearch_runner/*.py`

- [ ] **Step 1: Sync dependencies**

Run:

```bash
cd services/torghut
uv sync --frozen --extra dev
```

Expected: exits `0`.

- [ ] **Step 2: Run autoresearch split tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest -n auto --dist=worksteal tests/autoresearch_runner -q
```

Expected: all `185` tests pass.

- [ ] **Step 3: Run workflow-adjacent Torghut test lanes**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_mlx_training_data.py tests/test_strategy_autoresearch.py tests/test_whitepaper_workflow.py -q
```

Expected: all selected tests pass.

- [ ] **Step 4: Run lint and format checks**

Run:

```bash
cd services/torghut
uv run --frozen ruff check tests/autoresearch_runner
uv run --frozen ruff format --check tests/autoresearch_runner
```

Expected: both commands exit `0`.

- [ ] **Step 5: Run Torghut pyright profiles**

Run:

```bash
cd services/torghut
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

Expected: all three pyright profiles report `0 errors`.

- [ ] **Step 6: Validate file size gate**

Run:

```bash
wc -l services/torghut/tests/autoresearch_runner/*.py
```

Expected:

- No individual `test_*.py` file is above `3,000` lines.
- `helpers.py` is below `1,000` lines.

## Task 5: Pull Request

**Files:**

- Modify: `.github/workflows/torghut-ci.yml`
- Add/Delete: autoresearch test files listed above.

- [ ] **Step 1: Start from fresh main**

Run:

```bash
git fetch origin
git switch main
git pull --ff-only
git switch -c codex/torghut-autoresearch-ci-single-job
```

- [ ] **Step 2: Commit with semantic message**

Run:

```bash
git add .github/workflows/torghut-ci.yml services/torghut/tests/autoresearch_runner services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py
git commit -m "ci(torghut): collapse autoresearch runner to one job"
```

- [ ] **Step 3: Create PR body from template**

Run:

```bash
tmp_pr_body="$(mktemp)"
cp .github/PULL_REQUEST_TEMPLATE.md "${tmp_pr_body}"
```

Fill it with:

```markdown
## Summary

- Split the monolithic Torghut autoresearch runner test file into focused files under `tests/autoresearch_runner/`.
- Replaced the 16-way `Pytest autoresearch runner N` matrix with one `Pytest autoresearch runner` CI job using local pytest-xdist.
- Kept autoresearch coverage isolated and preserved aggregate Torghut coverage download behavior.

## Related Issues

None

## Testing

- `cd services/torghut && uv sync --frozen --extra dev`
- `cd services/torghut && uv run --frozen pytest -n auto --dist=worksteal tests/autoresearch_runner -q`
- `cd services/torghut && uv run --frozen pytest tests/test_mlx_training_data.py tests/test_strategy_autoresearch.py tests/test_whitepaper_workflow.py -q`
- `cd services/torghut && uv run --frozen ruff check tests/autoresearch_runner`
- `cd services/torghut && uv run --frozen ruff format --check tests/autoresearch_runner`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`

## Screenshots (if applicable)

N/A

## Breaking Changes

None

## Checklist

- [x] Testing section documents the exact validation performed.
- [x] Screenshots and Breaking Changes sections are handled appropriately.
- [x] Documentation, release notes, and follow-ups are updated or tracked.
```

- [ ] **Step 4: Scan for placeholders**

Run:

```bash
rg -n "TODO|TBD|<|>|\\[ \\]" "${tmp_pr_body}"
```

Expected: no output.

- [ ] **Step 5: Open the PR**

Run:

```bash
pr_url="$(
  gh pr create -R proompteng/lab \
  --title "ci(torghut): collapse autoresearch runner to one job" \
  --body-file "${tmp_pr_body}"
)"
pr_number="${pr_url##*/}"
printf 'PR %s: %s\n' "${pr_number}" "${pr_url}"
```

## Task 6: CI Acceptance

**Files:**

- Validate remote GitHub checks only.

- [ ] **Step 1: Watch PR checks**

Run:

```bash
pr_number="$(gh pr view --json number --jq '.number' -R proompteng/lab)"
gh pr checks "${pr_number}" --watch -R proompteng/lab
```

Expected:

- Exactly one check row named `Pytest autoresearch runner`.
- No check rows named `Pytest autoresearch runner 0` through `Pytest autoresearch runner 15`.
- `Bytecode + pytest + coverage` passes.
- `Pyright` passes.
- Normal `Pytest shard 0..3` passes.
- Quality/static guards pass.

- [ ] **Step 2: Inspect CI timing**

Run:

```bash
run_id="$(
  gh run list -R proompteng/lab \
    --workflow torghut-ci.yml \
    --branch codex/torghut-autoresearch-ci-single-job \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId'
)"
gh run view "${run_id}" -R proompteng/lab --json jobs |
  jq -r '.jobs[] | select(.name == "Pytest autoresearch runner") | [.name,.status,.conclusion,.startedAt,.completedAt] | @tsv'
```

Expected: one completed successful job. If runtime exceeds `10m`, keep the single visible job but tune its internal command before merge.

- [ ] **Step 3: Squash merge after green checks**

Run:

```bash
pr_number="$(gh pr view --json number --jq '.number' -R proompteng/lab)"
gh pr merge "${pr_number}" --squash -R proompteng/lab
```

## Rollout And Smoke

- This is CI/test-only. No Argo, Knative, database, Alpaca, or Torghut runtime rollout is expected.
- If a Torghut image release PR is created unexpectedly, do not merge it. Investigate path filters because test-only and workflow-only changes should not require a runtime promotion.
- Smoke is the GitHub Actions surface:
  - the PR check list contains one autoresearch runner job,
  - the aggregate coverage job consumes the single autoresearch artifact,
  - no runtime deploy was triggered,
  - no rollback PR is created.

## Rollback

- If the single autoresearch job is unstable or too slow, revert only the CI job collapse first and keep the file split if tests are green.
- The emergency rollback is to restore the old 16-slice matrix from Git history, but the preferred fix is to keep one visible job and split slow tests further or mark truly expensive integration tests separately.

## Done Criteria

- `rg -n "Pytest autoresearch runner \\$\\{\\{ matrix.slice \\}\\}|SLICE_TOTAL|SLICE_INDEX|test_run_whitepaper_autoresearch_profit_target" .github/workflows/torghut-ci.yml services/torghut/tests` returns no output.
- `uv run --frozen pytest --collect-only -q tests/autoresearch_runner` reports `185` collected tests.
- `gh pr checks` shows one `Pytest autoresearch runner` check and no numbered autoresearch check rows.
- All PR checks are green before merge.
