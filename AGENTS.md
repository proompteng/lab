# Repository Guidelines

## Project Structure & Module Organization
- `apps/`: Next.js/TanStack frontends with tests.
- `packages/`: shared TS libs plus the Convex backend (`packages/backend`).
- `services/`: Go, Kotlin, Rails, and Python services.
- `argocd/`, `kubernetes/`, `tofu/`, `ansible/`: infra + GitOps manifests.
- `scripts/`, `packages/scripts/`: build/deploy helpers.
- `skills/`: agent skills; each skill includes a `SKILL.md`.

## Build, Test, and Development Commands
- `bun install`: dependencies.
- `bun run dev:<app>`: run a frontend (e.g., `dev:proompteng`).
- `bun run build:<app>` / `bun run start:<app>`: build/serve a frontend.
- `bun run dev:convex`: run the Convex backend locally.
- `bun run format` / `bun run lint:<name>`: format or lint JS/TS.
- `bun run --filter <workspace> test`: run workspace tests (Vitest/Bun test).
- `go test ./services/...` / `go build ./services/...`: test or build Go services.

## Memories Service Helpers
- Save entries with `bun run --filter memories save-memory --task-name … --content … --summary … --tags …`.
- Retrieve entries with `bun run --filter memories retrieve-memory --query … --limit <n>`; uses `schemas/embeddings/memories.sql` and OpenAI embedding env vars.

## Coding Style & Naming Conventions
- JS/TS: Biome (2-space indent, single quotes, trailing commas).
- TSX: Tailwind CSS only; prefer responsive utilities and `cn()` for conditionals.
- Naming: `kebab-case` files, `PascalCase` components/types, `camelCase` functions.
- Go: `gofmt`; wrap errors with context (`fmt.Errorf("context: %w", err)`).
- Kotlin: `ktlint`; Rails follows default Ruby style.

## Testing Guidelines
- Co-locate tests: `*.test.ts(x)`, `*_test.go`, `src/test/kotlin/*Test.kt`, `test/**`, `alchimie_tests/`.
- Prefer fast unit tests; add integration tests when needed.

## Agent Execution Guidelines (Performance)
- Start with precise code pointers: use file paths, greppable identifiers, and stack traces to narrow search.
- Reproduce issues before changing code; keep logs and failing commands in your notes.
- Run the smallest relevant validation (single test, scoped lint, or targeted build) and record the exact command.
- Split large requests into smaller steps; call out ambiguities early instead of guessing.
- Follow the closest skill in `skills/<name>/SKILL.md` when a task matches its description.

## Review Guidelines (for Codex GitHub reviews)
- Focus on correctness regressions, error handling, and missing tests.
- Flag infra changes that touch `argocd/`, `tofu/`, `kubernetes/`, or `ansible/` for rollout/impact notes.
- Treat security issues (secrets, auth gaps, PII logging) as highest priority.

## Generated Artifacts & Safety
- Do not edit generated directories (`dist/`, `build/`, `_generated/`) or lockfiles (`bun.lock`, `bun.lockb`).
- Update GitOps state via manifests in `argocd/` rather than live clusters.
