# Repository Guidelines

## Project Structure & Module Organization
- `apps/`: Next.js/TanStack frontends (tests co-located).
- `packages/`: shared TS libs + Convex backend (`packages/backend`).
- `services/`: Go, Kotlin, Rails, and Python services.
- `argocd/`, `kubernetes/`, `tofu/`, `ansible/`: infra + GitOps.
- `scripts/`, `packages/scripts/`: build/deploy helpers.
- `scripts/init_skill.py`: bootstrap new skills in `skills/`.
- `skills/`: agent skills; each skill includes a `SKILL.md`.

## Prereqs
- Node 24.11.1 + Bun 1.3.5 (root `package.json`).
- Go 1.24+ for `services/`.
- Ruby 3.4.7 + Bundler 2.7+ for `services/dernier`.
- Python 3.9–3.12 for `apps/alchimie`; 3.11–3.12 for `services/torghut`.

## Tooling Versions (mise)
- Use `mise` to pin tool versions when a specific major is required (e.g. `helm@3` for `kustomize --enable-helm`; helm v4 is not supported there yet).

## Build, Test, and Development Commands
- `bun install`: dependencies.
- `bun run dev:<app>` / `bun run build:<app>` / `bun run start:<app>`: run/build/serve a frontend.
- `bun run dev:convex`: run the Convex backend locally.
- `bun run --filter @proompteng/backend codegen` / `bun run seed:models`: Convex codegen/seed.
- `bun run format` / `bun run lint:<name>` / `bunx biome check <paths>`: format or lint JS/TS.
- `bun run proto:generate`: regenerate protobuf outputs.
- `go test ./services/...` / `go build ./services/...`: test or build Go services; run `go mod tidy` in the service when touching deps.
- Infra: `bun run tf:plan`, `bun run tf:apply`, `bun run lint:argocd`, `bun run ansible`.

## Workspace Filtering & Single-Test Patterns
- Scope with `bun run --filter <workspace> <script>` (multiple filters ok).
- JS tests: `bun run --filter <workspace> test -- path/to/test.ts -t "name"` (Vitest) or `bun test -t "name" tests/foo.test.ts` (Bun).
- Other: `go test ./services/prt -run TestName`; `./gradlew test --tests "pkg.ClassTest"`; `bundle exec rails test test/models/user_test.rb:42`; `pytest alchimie_tests/test_file.py -k "pattern"`.

## Memories Service Helpers
- Save: `bun run --filter memories save-memory --task-name … --content … --summary … --tags …`.
- Retrieve: `bun run --filter memories retrieve-memory --query … --limit <n>`; uses `schemas/embeddings/memories.sql` and OpenAI embedding env vars.

## Coding Style & Naming Conventions
- Biome: 2-space indent, single quotes, trailing commas, 120-char width; auto-organizes imports.
- Imports: standard → third-party → internal; blank lines between groups.
- Naming: `kebab-case` files, `PascalCase` components/types, `camelCase` functions.
- Prefer explicit `if/else` over nested ternaries; use `async/await` consistently.
- Go: `gofmt -w <files>`; wrap errors with context (`fmt.Errorf("context: %w", err)`).
- Kotlin: `ktlint`; Rails follows default Ruby style.

## Semantic Commit Conventions
- Use Conventional Commits: `<type>(<scope>): <summary>` (scope optional).
- Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `revert`.
- PR titles must follow the same semantic convention.
- Create PRs by copying `.github/PULL_REQUEST_TEMPLATE.md` into a temp file, fill the description there, then run `gh pr create --body-file <temp file>`.

## UI/UX
- Tailwind CSS only; class order layout → spacing → sizing → typography → colors; use `cn()` for conditionals.
- Zinc palette (primary zinc-900/100, secondary zinc-700/300), responsive utilities, no hardcoded widths/heights.
- Forms: Zod schemas in `schemas/` + `zodResolver`; validate after typing and keep errors inline.
- Do not edit base shadcn components directly; customize via composition or props.
- Add new shadcn components via the shadcn CLI; do not hand-create component files.

## Testing Guidelines
- Co-locate tests: `*.test.ts(x)`, `*_test.go`, `src/test/kotlin/*Test.kt`, `test/**`, `alchimie_tests/`.
- Prefer fast unit tests; add integration tests when needed.

## Agent Execution Guidelines
- Use precise code pointers (file paths, identifiers, stack traces) to narrow search.
- Reproduce issues before changes; keep logs and failing commands.
- Split large tasks; surface ambiguities early; use the planning tool `functions.update_plan` when appropriate.

## Review Guidelines
- Focus on correctness regressions, error handling, and missing tests.
- Flag infra changes in `argocd/`, `tofu/`, `kubernetes/`, or `ansible/` for rollout/impact notes.
- Treat security issues (secrets, auth gaps, PII logging) as highest priority.

## Merge Guidelines
- Use squash merges for pull requests.
- Use `gh pr merge 2202 --squash -R proompteng/lab` (no `--delete-branch`; avoids worktree checkout conflicts).

## Generated Artifacts & Safety
- Do not edit generated directories (`dist/`, `build/`, `_generated`) or lockfiles (`bun.lock`, `bun.lockb`); regenerate via the owning tool.
- Default to GitOps (edit `argocd/` manifests and let Argo CD sync). Only apply directly to the cluster when explicitly asked or in an emergency, and document the deviation.

## Kubernetes (kubectl)
- Use explicit namespaces with kubectl (e.g., `kubectl get pods -n <ns>`).
- Helm charts present: `mise exec helm@3 -- kustomize build --enable-helm <path> | kubectl apply -n <ns> -f -`.
- CNPG access: `kubectl cnpg psql -n <ns> <cluster> -- <psql args>` (psql flags after `--`).

## Temporal
- Temporal CLI usage, address, namespace, and task queue defaults live in `skills/temporal/SKILL.md` (source of truth).

## When in Doubt
- Check the nearest README for service-specific commands.
- Search internet with correct keyword and questions containing context using web.run.
