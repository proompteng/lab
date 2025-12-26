# Repository Guidelines

## Project Structure & Module Organization
- `apps/`: Next.js/TanStack frontends with co-located tests and fixtures.
- `packages/`: shared TypeScript libs plus the Convex backend (`packages/backend`).
- `services/`: Go microservices, Kotlin/Quarkus, Rails API, and Python services.
- `argocd/`, `kubernetes/`, `tofu/`, `ansible/`: infra and GitOps manifests.
- `scripts/` and `packages/scripts/`: build/deploy helpers.
- `skills/`: agent skills; each skill includes a `SKILL.md` with usage guidance.

## Build, Test, and Development Commands
- `bun install`: install workspace dependencies.
- `bun run dev:<app>`: run a frontend locally (e.g., `dev:proompteng`).
- `bun run build:<app>` / `bun run start:<app>`: build and serve a frontend.
- `bun run dev:convex`: start the Convex backend locally.
- `bun run format`: format JS/TS with Biome; `bun run lint:<name>` for scoped linting.
- `go test ./services/...` / `go build ./services/...`: test or build Go services.
- Tests per workspace: `bun run --filter <workspace> test` (Vitest or Bun test).

## Coding Style & Naming Conventions
- JS/TS: Biome formatting (2-space indent, single quotes, trailing commas).
- TSX: Tailwind CSS only; prefer responsive utilities and `cn()` for conditionals.
- Naming: files in `kebab-case`, components/types in `PascalCase`, functions in `camelCase`.
- Go: use `gofmt`; wrap errors with context (`fmt.Errorf("context: %w", err)`).
- Kotlin: `ktlint`; Rails follows default Ruby style.

## Testing Guidelines
- Keep tests next to code: `*.test.ts(x)` for TS, `*_test.go` for Go, `src/test/kotlin/*Test.kt` for Kotlin, `test/**` for Rails, `pytest` under `alchimie_tests/`.
- Prefer fast unit tests first; add integration tests only when needed.

## Commit & Pull Request Guidelines
- Use Conventional Commit-style messages (e.g., `feat(scope): summary`, `fix: summary`, `docs: summary`).
- PRs should include a clear description, linked issue/PR numbers (e.g., `#1234`), and a brief test plan.
- Include screenshots for UI changes; note rollout/impact for infra updates in `argocd/`, `tofu/`, or `kubernetes/`.

## Generated Artifacts & Safety
- Do not edit generated directories (`dist/`, `build/`, `_generated/`) or lockfiles (`bun.lock`, `bun.lockb`).
- Update GitOps state via manifests in `argocd/` rather than live clusters.
