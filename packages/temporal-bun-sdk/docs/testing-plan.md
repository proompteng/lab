
> CI uses the same helper scripts to run `TEMPORAL_TEST_SERVER=1 bun test ...` against a CLI-backed server.

### Test Cases
1. **Happy path workflow**
   - Start `helloTemporal`, ensure activity runs, verify result.
2. **Signal & Query**
   - Signal workflow mid-flight, query result.
3. **Failures**
   - Activity failure -> workflow retry -> success.
   - Workflow throwing error -> verify failure payload.
4. **Heartbeats**
   - Long-running activity heartbeats then completes.
5. **Continue-as-new**
   - Workflow loops via continue-as-new; ensure history trimmed.
6. **Shutdown**
   - Send SIGTERM to worker container, ensure graceful exit recorded.

Integration suite should run in CI pipeline (GitHub Actions) on macOS + Linux.

---

## 4. Replay Harness

- Capture history from running workflow (via Temporal client).
- Feed into workflow runtime offline, ensure command sequence matches.
- Useful for regression tests and to guard determinism before publishing.

---

## 5. CLI / Scaffolding Tests

- Existing `cli.test.ts` ensures template generation does not overlap.
- Add E2E test: run `temporal-bun init` in temp dir, run `bun install --production` (with local workspace), ensure scripts exist.
- Optionally run `bun run dev` for short duration (spawn worker, ensure no crashes).

---

## 6. CI Recommendations

- **Job 1:** Lint + typecheck (Biome, `bunx tsc` without emit).
- **Job 2:** Build native bridge (macOS + Linux).
- **Job 3:** Run unit tests (`bun test`).
- **Job 4:** Run integration tests (docker-compose) — mark as optional / nightly if heavy.
- Publish coverage to help track progress (use `c8` with Bun once available).

---

## 7. Manual QA Checklist (pre-release)

1. Scaffold new project via CLI, run worker locally.
2. Build Docker image (`bun run docker:build`), run worker inside container.
3. Connect to Temporal Cloud with TLS/API key, run smoke workflow.
4. Validate telemetry emitted to Prometheus endpoint if feature implemented.

Keep this plan evolving as the SDK matures; update the table whenever new subsystems (e.g., Nexus, search attributes) arrive.
