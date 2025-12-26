# Repository Guidelines

## Project Structure & Module Organization
- `apps/`: Next.js/TanStack frontends with tests.
- `packages/`: TS libs plus the Convex backend (`packages/backend`).
- `services/`: Go, Kotlin, Rails, and Python services.
- `argocd/`, `kubernetes/`, `tofu/`, `ansible/`: infra + GitOps.
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

## Coding Style & Naming Conventions
- JS/TS: Biome (2-space indent, single quotes, trailing commas).
- TSX: Tailwind CSS only; prefer responsive utilities and `cn()` for conditionals.
- Naming: `kebab-case` files, `PascalCase` components/types, `camelCase` functions.
- Go: `gofmt`; wrap errors with context (`fmt.Errorf("context: %w", err)`).
- Kotlin: `ktlint`; Rails follows default Ruby style.

## Testing Guidelines
- Co-locate tests: `*.test.ts(x)`, `*_test.go`, `src/test/kotlin/*Test.kt`, `test/**`, `alchimie_tests/`.
- Prefer fast unit tests; add integration tests when needed.

## Commit & Pull Request Guidelines
- Conventional Commit messages (e.g., `feat(scope): summary`, `fix: summary`, `docs: summary`).
- PRs: clear description, linked issues (e.g., `#1234`), test plan; add UI screenshots and infra rollout notes when relevant.

## Agent Workflow & Instruction Discovery
- Agents read `AGENTS.md` from the repo root and the nearest directory; use nested files for subproject rules.
- Keep prerequisites and test commands current; agents perform best with configured dev environments and reliable tests.
- Use `AGENTS.override.md` in a subdirectory to replace parent guidance; keep instruction files under 32 KiB.
- For best results, include file paths, error logs, and exact validation steps in requests; split large tasks into smaller ones.
- If using Codex review in GitHub, add a `## Review guidelines` section to steer what the reviewer prioritizes.

## Generated Artifacts & Safety
- Do not edit generated directories (`dist/`, `build/`, `_generated/`) or lockfiles (`bun.lock`, `bun.lockb`).
- Update GitOps state via manifests in `argocd/` rather than live clusters.
