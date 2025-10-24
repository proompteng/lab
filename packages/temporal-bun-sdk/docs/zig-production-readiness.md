# Temporal Bun Zig Bridge — Production Readiness

**Status (20 Oct 2025): Scaffold only.** The Zig bridge exports the FFI surface but still relies on stubbed runtime,
client, and worker implementations. The checklist below captures what remains before the Zig bridge can replace
the Rust bridge as the default.

## 1. Technical Completeness
- [ ] Feature parity issues for `zig-rt-*`, `zig-cl-*`, `zig-wf-*`, `zig-buf-*`, `zig-pend-*` are closed. (Open examples:
  `zig-rt-02`, `zig-rt-03`, `zig-rt-04`, `zig-cl-01`…`zig-cl-04`, `zig-wf-01`…`zig-wf-06`, `zig-worker-01`…`zig-worker-09`.)
- [ ] All inline `TODO(codex, …)` markers are removed or mapped to open issues. Current gaps include
  `zig-core-02`, `zig-cl-04`, and `zig-pack-01`.
- [ ] `docs/testing-plan.md` documents Zig scenarios next to Rust, and the test matrix reflects the planned
  end-to-end coverage.

## 2. Automated Verification
- [ ] Dedicated Zig CI workflow (e.g. `.github/workflows/temporal-bun-sdk-zig.yml`) runs `zig build test` plus Bun
  smoke tests on every PR.
- [ ] Nightly Docker-based smoke (`tests/docker-compose.yaml`) exercises the Zig bridge path and reports separately
  from the Rust bridge.
- [ ] Flaky Zig tests, if any, are triaged with documented owners and follow-ups.

## 3. Packaging & Distribution
- [ ] `zig-pack-01` links the bridge against vendored Temporal static libraries; `zig-pack-02` copies platform
  artifacts into `dist/native/<platform>/<arch>/`.
- [ ] Release automation publishes Zig binaries (macOS arm64/x64, Linux arm64/x64, Windows/MSVC once available) with
  signatures/provenance.
- [ ] README and publish notes explain how SDK consumers opt into/out of the Zig bridge and which platforms are supported.

## 4. Security & Compliance
- [ ] Supply-chain review covers the Zig toolchain, vendored headers, and build scripts.
- [ ] Vulnerability scanning (e.g. `trivy fs`) includes the Zig artifacts in release gating.
- [x] Downgrade/rollback guidance for the Zig bridge versus Rust fallback is documented (legacy only) — Rust fallback removed on October 24, 2025.

## 5. Observability & Ops
- [ ] Telemetry, logging, and tracing parity is delivered (`zig-rt-03`, `zig-rt-04`, byte-array metrics surfaced to Bun).
- [ ] Runbooks describe Zig-specific failure signatures and debugging workflows.
- [ ] Platform dashboards/SLOs include Zig bridge metrics and alert hooks.

## 6. Rollout & Communication
- [ ] Staging rollout with shadow traffic validates the Zig bridge against real Temporal workloads.
- [ ] Announcements (Slack, release notes) communicate the rollout plan and support channels.
- [ ] Support FAQ covers bridge selection, troubleshooting, and feature gaps while both bridges coexist.

## 7. Post-Launch Governance
- [ ] CODEOWNERS/escalation contacts for the Zig bridge are recorded and kept current.
- [ ] Dependency review cadence (Temporal core headers/libraries, Zig versions) is scheduled and tracked.
- [ ] Rust bridge deprecation plan (timeline, migration steps) is approved and published.

Update this checklist as milestones close so reviewers can see at a glance when the Zig bridge is truly production ready.
