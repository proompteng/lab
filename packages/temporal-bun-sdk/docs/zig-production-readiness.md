# Temporal Bun Zig Bridge — Production Readiness

The Zig bridge must satisfy the following formalities before we flip the default from Rust to Zig. Each
item is designed to be auditable during release reviews.

## 1. Technical Completeness
- ✅ Feature parity issues closed for IDs `zig-rt-*`, `zig-cl-*`, `zig-wf-*`, `zig-buf-*`, `zig-pend-*`.
- ✅ All TODO markers removed or converted to tracked issues with owners.
- ✅ Integration matrix (`docs/testing-plan.md`) updated with Zig scenarios alongside Rust.

## 2. Automated Verification
- ✅ GitHub Actions: `.github/workflows/temporal-bun-sdk.yml` (Rust) and `.github/workflows/temporal-bun-sdk-zig.yml` (Zig) both green.
- ✅ Nightly job executes Docker-based end-to-end smoke (`tests/docker-compose.yaml`) against Zig bridge.
- ✅ Test failures gate releases; flaky tests quarantined with documented follow-up.

## 3. Packaging & Distribution
- ✅ `zig-pack-01`/`zig-pack-02` complete — Zig artifacts bundled for macOS (x64/arm64) and Linux (x64/arm64); Windows/MSVC remains scoped to `zig-pack-03`.
- ✅ Hash-signed release assets published to GitHub Releases with provenance metadata.
- ✅ Package README highlights Zig vs Rust bridge selection and environment variables.

## 4. Security & Compliance
- ✅ Supply chain review complete (Zig toolchain, cbindgen output, vendored Temporal headers).
- ✅ Vulnerability scan on Zig artifacts (e.g., `trivy fs`) integrated into release workflow.
- ✅ Security advisory filed for potential downgrade path (Rust fallback), including rollback steps.

## 5. Observability & Ops
- ✅ Telemetry parity delivered (logs, metrics, tracing) with hooks plumbed into Bun runtime.
- ✅ Runbooks updated: failure signatures, debugging steps, and rollback instructions.
- ✅ SLO dashboards include Zig bridge metrics with alerts routed to Platform Runtime.

## 6. Rollout & Communication
- ✅ Dry-run rollout in staging namespace with shadow traffic compared against Rust bridge.
- ✅ Change announcement posted in #platform-runtime and added to the weekly release notes.
- ✅ Support playbook updated with FAQ entry covering bridge selection and troubleshooting.

## 7. Post-Launch Governance
- ✅ Ownership recorded in `CODEOWNERS`; escalate-to contact documented.
- ✅ Quarterly review cadence established to audit Temporal dependency updates.
- ✅ Deprecation plan for Rust bridge communicated (timeline + migration steps).

Track each checklist item in the project board before merging the “Zig default” PR.
