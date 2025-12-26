# Repository Guidelines for Agents

This file guides agentic coding assistants working in this repo.
Be surgical: change only what is needed and match existing patterns.

## Repo map
- apps/*: Next.js/TanStack frontends with co-located tests.
- packages/*: shared TS libs, Convex backend, tooling.
- services/*: Go services, Kotlin/Quarkus service, Rails API, Python services.
- argocd/, tofu/, ansible/, kubernetes/: infrastructure and GitOps.
- scripts/, packages/scripts/: build and deploy helpers.
- skills/: Codex Agent Skills—`SKILL.md` bundles with metadata + instructions (optional scripts/resources) for repeatable workflows.

## Prereqs
- Node 24.11.1 and Bun 1.3.5 (root package.json).
- Go 1.24+ for services.
- Ruby 3.4.7 + Bundler 2.7+ for `services/dernier`.
- Python 3.9-3.12 for `apps/alchimie`, 3.11-3.12 for `services/torghut`.

## Install and global commands
- Install JS deps: `bun install`.
- Format all: `bun run format` (Biome).
- Lint an app/package: `bun run lint:<name>` (e.g., `lint:proompteng`).
- Build an app: `bun run build:<name>`; start: `bun run start:<name>`.
- Generate protos: `bun run proto:generate`.
- Go build/tests: `go build ./services/...`, `go test ./services/...`.

## TypeScript/Bun workspaces
- Dev server: `bun run dev:<app>` (e.g., `dev:proompteng`).
- Vitest workspaces (apps/froussard, packages/codex, services/golink, etc.):
- All tests: `bun run --filter <workspace> test`.
- Single file: `bun run --filter <workspace> test -- path/to/test.ts`.
- Single test: `bun run --filter <workspace> test -- -t "name"`.
- Bun test workspaces (services/memories, services/bumba, packages/temporal-bun-sdk, etc.):
- All tests: `bun run --filter <workspace> test`.
- Single file: `bun run --filter <workspace> test -- tests/foo.test.ts`.
- Single test: `bun test -t "name" tests/foo.test.ts`.
- Lint JS/TS in scope: `bunx biome check <paths>`.

## Convex backend (packages/backend)
- Dev: `bun run dev:convex` (runs Convex locally).
- Setup: `bun run dev:setup:convex`.
- Codegen: `bun run --filter @proompteng/backend codegen`.
- Seed models: `bun run seed:models`.

## Go services
- Run all tests: `go test ./services/...`.
- Single package: `go test ./services/prt`.
- Single test: `go test ./services/prt -run TestHandleRoot`.
- Go formatting: `gofmt -w <files>` (also via lint-staged).
- Run `go mod tidy` inside the specific service directory.

## Kotlin/Gradle (services/graf)
- Tests: `./gradlew test`.
- Single test class: `./gradlew test --tests "ai.proompteng.graf.services.GraphServiceTest"`.
- Dev server: `./gradlew quarkusDev`.
- Format/lint: `./gradlew ktlintCheck` (or `ktlintFormat`).

## Rails (services/dernier)
- Setup: `bundle install` then `bundle exec rails db:prepare`.
- Tests: `bundle exec rails test` (requires test `DATABASE_URL`).
- Single test file or line: `bundle exec rails test test/models/user_test.rb:42`.
- Dev: `bundle exec rails server` or `bin/dev` (tailwind watch).

## Python
- apps/alchimie:
- Install: `pip install -e ".[dev]"`.
- Dev: `dagster dev`.
- Tests: `pytest alchimie_tests`.
- Single test: `pytest alchimie_tests/test_file.py -k "pattern"`.
- services/torghut:
- Dev: `uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8181`.
- Type check: `uv run pyright`.

## Infra helpers
- OpenTofu: `bun run tf:plan`, `bun run tf:apply`.
- ArgoCD manifest lint: `bun run lint:argocd` (kubeconform).
- Ansible playbook: `bun run ansible`.

## Single-test cheat sheet
- Vitest: `bun run --filter <workspace> test -- path/to/test.ts -t "pattern"`.
- Bun test: `bun test -t "pattern" tests/foo.test.ts`.
- Go: `go test ./services/prt -run TestName`.
- Kotlin: `./gradlew test --tests "ai.proompteng.graf.SomeTest"`.
- Rails: `bundle exec rails test test/models/user_test.rb:42`.
- Pytest: `pytest alchimie_tests/test_file.py -k "pattern"`.

## Workspace filtering tips
- Use `bun run --filter <workspace> <script>` to target one package.
- Multiple `--filter` flags are allowed when a task spans packages.
- Scoped names keep the `@scope/name` (example: `@proompteng/golink`).
- Use `turbo run <task> --filter <workspace>` if Turbo is already in use.

## Testing conventions
- TS/TSX tests: `*.test.ts` / `*.test.tsx` next to code.
- Go tests: `*_test.go` next to implementation.
- Kotlin tests: `src/test/kotlin/**` with `*Test.kt`.
- Rails tests: `test/**` (Minitest).
- Keep fast unit tests first; add slower integration tests only when needed.

## Formatting and linting
- Biome config in `biome.json` controls JS/TS formatting and lint rules.
- Biome uses 2-space indent, single quotes, trailing commas, 120 char line width.
- Biome auto-organizes imports; do not hand-sort into non-standard orders.
- For Kotlin, use ktlint; for Go, use gofmt; for Ruby, follow Rails defaults.

## Code style and conventions
- Imports: standard library -> third-party -> internal; blank lines between groups.
- Naming: files in kebab-case; components/types in PascalCase; vars/functions in camelCase.
- Avoid nested ternaries; prefer explicit if/else for clarity.
- Prefer small, focused modules; keep tests close to the code they cover.
- Types: keep public APIs explicit; use `z.infer` or `typeof` helpers for schema-driven types.
- Error handling: never swallow errors; attach context and keep stack traces.
- Go errors: wrap with `fmt.Errorf("context: %w", err)`.
- Use `async`/`await` consistently; avoid mixing callbacks and promises.

## Cursor rules (from .cursor/rules/*.mdc, apply to *.tsx)
- Styling: Tailwind CSS only; avoid custom CSS.
- Class ordering: layout -> spacing -> sizing -> typography -> colors.
- Color palette: zinc for backgrounds/text; primary zinc-900/100, secondary zinc-700/300.
- Use `cn()` for conditional classNames.
- Prefer responsive utilities; do not hardcode width/height.
- Use CSS variables for dynamic values; use `theme()` for config access.
- Animations: Framer Motion for complex, Tailwind transitions for simple.
- Accessibility: add proper ARIA attributes; optimize for a11y/perf.
- Component structure: separate view vs logic; prefer composition.
- Schema validation: Zod for forms, APIs, and AI outputs.
- Form schemas live in `schemas/`; use `zodResolver` with React Hook Form.
- Validate with `.parse()`/`.safeParse()` and return formatted errors.
- File naming: kebab-case.

## UI/UX checklist (when touching UI)
- Preserve keyboard navigation and visible focus states.
- Keep tap targets at least 24px (44px on mobile).
- Do not block paste in inputs; validate after typing.
- Keep submit enabled until request starts; show loading state.
- Put errors inline and focus the first error on submit.
- Use links for navigation to preserve browser behaviors.
- Respect `prefers-reduced-motion`.
- Confirm destructive actions or provide undo.
- Use aria-live for toasts/inline validation.

## Generated artifacts and safety
- Do not edit generated code in `dist/`, `build/`, `_generated`, or vendored dirs.
- Regenerate artifacts via the owning tool instead.
- Never hand-edit lockfiles (`bun.lock`, `bun.lockb`).
- Avoid touching ArgoCD live state; update manifests in `argocd/`.
- Prefer read-only kubectl commands unless explicitly asked.

## When in doubt
- Check the nearest README for service-specific commands.
- Prefer the smallest-scoped test that proves the change.
