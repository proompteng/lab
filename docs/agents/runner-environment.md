# AgentRun development environment

The production Codex Job uses the single `agents-codex-runner` Nix image. Its tools are defined in
`nix/images/agentrun-tools.nix` and composed by `nix/images/agents.nix`. The retired runner Dockerfile is removed.

The image includes the official Codex executable and app-server adapter, Bun and Node, the repository's Nix-pinned
Rust compiler/Cargo/rustfmt/Clippy, Buf, the C/C++ compiler, CMake, protobuf compiler, OpenSSL, UUID tools, ripgrep,
the existing patch helper and standard `/usr/bin/env` interpreter path.

Headless Chromium is pinned to Playwright 1.59.1 and revision 1217 on AMD64 and ARM64. Browser archives are hash-checked
and their ELF dependencies are resolved at build time. The image provides fonts and fontconfig, the Playwright browser
cache path and `PLATFORM_UI_CHROMIUM`. Browser downloads are disabled. Update both architecture hashes and the version
contract when changing the checkout's Playwright dependency. A checkout with a different version fails acceptance.

## Acceptance

Run `agentrun-acceptance --smoke` to verify executable availability, certificate generation, Rust compilation and a
real browser-rendered PNG. Agents image CI runs it in a fresh Pod for runner image changes.

Run `agentrun-acceptance /workspace/lab /workspace/.agent/acceptance` for full checkout acceptance. It installs locked
workspace JavaScript dependencies, runs the real Chromium admin fixture, captures screenshots and runs the platform,
policy and qualified-schema tests. The output directory contains logs, screenshots and `result.json`. A failed check
exits nonzero and does not produce a passing result. The browser/toolchain needs no runtime downloads or repairs.

## Disposable Ofz services

`test-control.sh platform`, `test-policy.sh` and `qualify-platform.sh` use `tests/platform_fixture.py`. Each invocation
starts its own PostgreSQL 18.6 and production-pinned SpiceDB 1.56.2, temporary data directory, loopback listeners and
one-day fixture CA. PostgreSQL connections require TLS. Dispatch caches remain disabled, preserving the policy
expiration/revocation qualification. Root Jobs run PostgreSQL as the image's unprivileged `ofz-fixture` identity.

The fixture terminates its process groups and deletes its directory on success, failure and normal termination.
It never reads a production DSN or changes production relationships. No Kubernetes resource permissions, Docker
daemon, privileged sidecar or host socket are required. There is no Docker fallback for these migrated callers.
Other control/identity/archive/failover modes retain their existing separate qualification environment.
