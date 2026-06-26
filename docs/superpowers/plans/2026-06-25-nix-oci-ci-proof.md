# Nix OCI CI Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Nix OCI/multi-arch adoption with pushed CI proof and measured build-time deltas.

**Architecture:** Keep Nix as the pinned toolchain layer, run native per-architecture OCI builds on ARC runners, publish an OCI index with crane, and measure legacy single-runner multi-platform builds against native Buildx and direct BuildKit. Branch canaries must never mutate `latest`; only `main` may publish `latest`.

**Tech Stack:** Nix flakes, GitHub Actions, Docker Buildx, BuildKit `buildctl`, crane/go-containerregistry, Bun tests, actionlint, shellcheck.

---

### Task 1: Make Branch Canary Safe

**Files:**
- Modify: `.github/workflows/facteur-build-push.yaml`

- [ ] **Step 1: Gate `latest` to main only**

Change the reusable workflow input to:

```yaml
      latest: ${{ github.ref == 'refs/heads/main' }}
```

- [ ] **Step 2: Validate workflow syntax**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import yaml
for path in sorted(Path('.github/workflows').glob('*.y*ml')):
    with path.open() as handle:
        yaml.safe_load(handle)
print('workflow yaml ok')
PY
```

Expected: `workflow yaml ok`.

### Task 2: Add Legacy Baseline Benchmark

**Files:**
- Modify: `.github/workflows/oci-builder-benchmark.yml`

- [ ] **Step 1: Add a legacy single-runner job**

Add a job named `legacy-buildx-single-runner` that runs on `arc-arm64`, uses `docker/build-push-action@v6`, builds `linux/amd64,linux/arm64` together, pushes only benchmark tags, and records elapsed seconds plus digest to `GITHUB_STEP_SUMMARY`.

- [ ] **Step 2: Keep native benchmark jobs**

Keep existing native matrix jobs for Docker Buildx and direct `buildctl`.

- [ ] **Step 3: Include legacy in summary**

Add `legacy-buildx-single-runner` to the `summarize.needs` list and print its result.

- [ ] **Step 4: Validate workflow lint**

Run:

```bash
actionlint -ignore 'label "arc-(amd64|arm64)" is unknown' \
  .github/workflows/oci-native-build-common.yml \
  .github/workflows/oci-builder-benchmark.yml \
  .github/workflows/facteur-build-push.yaml \
  .github/workflows/nix-toolchain.yml
```

Expected: no output.

### Task 3: Commit, Push, PR

**Files:**
- Modify only files already touched by this Nix/OCI adoption.

- [ ] **Step 1: Run focused validation**

Run:

```bash
bun test packages/scripts/src/shared/__tests__/oci.test.ts packages/scripts/src/shared/__tests__/docker.test.ts
bunx oxfmt --check packages/scripts/src/shared/oci.ts packages/scripts/src/shared/__tests__/oci.test.ts
shellcheck -s bash nix/toolchain-doctor.sh nix/oci-doctor.sh
git diff --check
```

Expected: all exit 0.

- [ ] **Step 2: Commit**

Run:

```bash
git add .
git commit -m "feat(nix): add native oci build tooling"
```

- [ ] **Step 3: Push**

Run:

```bash
git push -u origin codex/adopt-nix-toolchain
```

- [ ] **Step 4: Create PR from template**

Copy `.github/PULL_REQUEST_TEMPLATE.md` to a temp file, fill every section, scan for placeholders, and run:

```bash
gh pr create -R proompteng/lab --title "feat(nix): add native oci build tooling" --body-file /tmp/<filled-template>.md
```

### Task 4: Run CI Proof

**Files:**
- No repo edits expected unless CI fails.

- [ ] **Step 1: Trigger branch canary**

Run:

```bash
gh workflow run facteur-build-push.yaml -R proompteng/lab --ref codex/adopt-nix-toolchain
```

- [ ] **Step 2: Trigger benchmark before merge**

For a PR branch where the new benchmark workflow is not yet present on `main`, add the explicit opt-in label:

```bash
gh label create run-oci-benchmark -R proompteng/lab --color 5319e7 --description "Run OCI builder benchmark on PR" || true
gh pr edit <pr-number> -R proompteng/lab --add-label run-oci-benchmark
```

The benchmark workflow runs on `pull_request` events only when this label is present.

- [ ] **Step 3: Trigger benchmark after merge**

Run:

```bash
gh workflow run oci-builder-benchmark.yml -R proompteng/lab --ref codex/adopt-nix-toolchain \
  -f image_name=facteur \
  -f dockerfile=services/facteur/Dockerfile \
  -f context=. \
  -f tag_prefix=benchmark-nix-oci \
  -f build_args_json='{}'
```

- [ ] **Step 4: Watch runs**

Run:

```bash
gh run list -R proompteng/lab --branch codex/adopt-nix-toolchain --limit 10
gh run watch <run-id> -R proompteng/lab --exit-status
```

- [ ] **Step 5: Extract timings**

Run:

```bash
gh run view <benchmark-run-id> -R proompteng/lab --json jobs
```

Compare:

- Legacy wall time: `legacy-buildx-single-runner`
- Native Buildx wall time: max of `Docker Buildx native (amd64)` and `Docker Buildx native (arm64)`
- BuildKit wall time: max of `BuildKit buildctl native (amd64)` and `BuildKit buildctl native (arm64)`

### Task 5: Report Proof

**Files:**
- No repo edits expected.

- [ ] **Step 1: Report measured deltas**

Report exact run URLs, job durations, and percentage change:

```text
speedup = (legacy_seconds - native_seconds) / legacy_seconds * 100
```

- [ ] **Step 2: If CI fails, fix and repeat**

For any failed workflow, inspect logs, patch the repo, rerun focused validation, amend or add a commit, push, and rerun the failed workflow.
