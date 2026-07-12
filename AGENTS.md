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

- Prefer `nix develop` from the repo root before running build, test, or infra commands. Run `toolchain-doctor`
  inside the shell when a tool version looks suspect.
- Node 24.11.1 + Bun 1.3.14 (root `package.json`).
- Go 1.25.5 for repo parity; Go services support 1.24+.
- Ruby 3.4.7 + Bundler 2.7+ for `services/dernier`.
- Python 3.9–3.12 for `apps/alchimie`; 3.11–3.12 for `services/torghut`.

## Tooling Versions (Nix)

- Use `nix develop` to get the pinned repo toolchain. This includes Helm 3 for `kustomize --enable-helm`;
  helm v4 is not supported there yet.
- Optional direnv setup is local-only: copy `.envrc.example` to `.envrc` and run `direnv allow`.

## Build, Test, and Development Commands

- `bun install`: dependencies.
- `bun run dev:<app>` / `bun run build:<app>` / `bun run start:<app>`: run/build/serve a frontend.
- `bun run dev:convex`: run the Convex backend locally.
- `bun run --filter @proompteng/backend codegen` / `bun run seed:models`: Convex codegen/seed.
- `bun run format` / `bun run lint:<name>` / `bunx oxfmt --check <paths>`: format or lint JS/TS.
- `bun run proto:generate`: regenerate protobuf outputs.
- `go test ./services/...` / `go build ./services/...`: test or build Go services; run `go mod tidy` in the service when touching deps.
- Infra: `bun run tf:plan`, `bun run tf:apply`, `bun run lint:argocd`, `bun run ansible`.

## Workspace Filtering & Single-Test Patterns

- Scope with `bun run --filter <workspace> <script>` (multiple filters ok).
- JS tests: `bun run --filter <workspace> test -- path/to/test.ts -t "name"` (Vitest) or `bun test -t "name" tests/foo.test.ts` (Bun).
- Other: `go test ./services/prt -run TestName`; `./gradlew test --tests "pkg.ClassTest"`; `bundle exec rails test test/models/user_test.rb:42`; `pytest alchimie_tests/test_file.py -k "pattern"`.

## Code Search Helpers

- Default command:
  `bun run atlas:code-search --query "<what you need>" --repository proompteng/lab --limit 10`
- Narrow only if needed: add `--path-prefix <path>`, then `--language <name>`, then `--ref <ref>`.

## Memories Service Helpers

- Save: `bun run --filter memories save-memory --task-name … --content … --summary … --tags …`.
- Retrieve: `bun run --filter memories retrieve-memory --query … --limit <n>`; uses `schemas/embeddings/memories.sql` and OpenAI embedding env vars.

## Memories

- Make sure to read memories before the turn.
- Make sure to save memories after the turn.

## Coding Style & Naming Conventions

- Oxfmt: 2-space indent, single quotes, trailing commas, 120-char width (`.oxfmtrc.json`).
- Imports: standard → third-party → internal; blank lines between groups.
- Naming: `kebab-case` files, `PascalCase` components/types, `camelCase` functions.
- Prefer explicit `if/else` over nested ternaries; use `async/await` consistently.
- Go: `gofmt -w <files>`; wrap errors with context (`fmt.Errorf("context: %w", err)`).
- Kotlin: `ktlint`; Rails follows default Ruby style.

## Semantic Commit Conventions

- Use Conventional Commits: `<type>(<scope>): <summary>` (scope optional).
- Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `revert`.
- PR titles must follow the same semantic convention.
- Create PRs by copying `.github/PULL_REQUEST_TEMPLATE.md` into a temp file, fill the description there, then run `gh pr create --title "<type>(<scope>): <summary>" --body-file <temp file>`.

## Pull Requests

- PR descriptions must reflect the actual changes in the PR. Do not include aspirational TODOs or unrelated work.
- PR body MUST be created from `.github/PULL_REQUEST_TEMPLATE.md` and fully filled in before opening/updating the PR.
- Do not leave template placeholders in the PR body (examples: `TODO`, `TBD`, `<...>`, `[...]`, unchecked checklist items with no explanation).
- Do not duplicate template sections (example: multiple `## Summary` blocks). Keep exactly one copy of each template section you use.
- If a template section is not applicable, write `N/A` for that section (don’t delete the header, and don’t leave it blank).
- Before running `gh pr create` or `gh pr edit`, do a quick placeholder scan on the temp body file and remove anything that reads like template scaffolding.
- If a PR body is wrong after creation, fix it immediately with `gh pr edit <num> --body-file <temp file>` rather than “patching” it in the GitHub UI.

## Codex Reviews

- Treat Codex review as a required PR completion gate in addition to CI. Codex feedback can arrive after status checks pass, so do not merge or report a PR ready immediately after `gh pr checks` succeeds.
- Let the automatic Codex review run while CI is active. After CI completes, inspect the current head SHA, review submissions, unresolved threads, and PR reactions once; do not trigger or poll for Codex review.
- Treat a `+1` reaction from `chatgpt-codex-connector[bot]` on the PR as Codex approval when the reaction was created after the current head commit and there are no unresolved actionable Codex threads. GitHub reactions do not carry a reviewed commit SHA, so a later head commit makes the reaction stale and requires a new Codex review signal.
- Fetch thread-aware review state; flat issue/PR comments are insufficient. Inspect unresolved inline threads, review submissions, resolution state, and the reviewed commit SHA.
- Address actionable findings in severity order, with P0/P1 correctness, security, data-loss, and rollout issues blocking all lower-priority work. Add regression coverage or exact live validation appropriate to the finding.
- Push the fix before replying. Reply with the commit and validation evidence, and resolve the thread only after the fix is present on the PR branch.
- Do not merge or report a PR ready while an actionable Codex thread is unresolved, Codex review is still pending, or the only Codex review signal targets or predates the current head commit.

## UI/UX

- Tailwind CSS only; class order layout → spacing → sizing → typography → colors; use `cn()` for conditionals.
- Zinc palette (primary zinc-900/100, secondary zinc-700/300), responsive utilities, no hardcoded widths/heights.
- Forms: Zod schemas in `schemas/` + `zodResolver`; validate after typing and keep errors inline.
- Do not edit base shadcn components directly; customize via composition or props.
- Add new shadcn components via the shadcn CLI; do not hand-create component files.

## Testing Guidelines

- Co-locate tests: `*.test.ts(x)`, `*_test.go`, `src/test/kotlin/*Test.kt`, `test/**`, `alchimie_tests/`.
- Prefer fast unit tests; add integration tests when needed.
- For bug fixes, add a regression test that fails before the fix and passes after. If not feasible, document why and the exact manual validation performed.

## Agent Execution Guidelines

- Use precise code pointers (file paths, identifiers, stack traces) to narrow search.
- Reproduce issues before changes; keep logs and failing commands.
- Split large tasks; surface ambiguities early; use the planning tool `functions.update_plan` when appropriate.
- For deploying services, prefer the existing typed deploy tooling under `packages/scripts/` over ad-hoc shell scripts.

## Sub-agents

- Use sub-agents only for parallelizable work (repo discovery, grepping, reading docs, drafting focused diffs, writing test plans). Keep a single source of truth for decisions and final changes in the main agent.
- Sub-agent tools are `functions.spawn_agent`, `functions.send_input`, `functions.wait`, and `functions.close_agent` (some runtimes also support `resume_agent`).
- Delegate with a concrete prompt and explicit ownership. Sub-agents must not touch files outside their ownership; if needed, report back and ask the main agent to re-scope.
- Prompt template:

```text
Objective: <one sentence>
Ownership: You own <path/glob> only
Scope: <do X; avoid Y>
Constraints: <style/testing/infra constraints>
Output:
- Option A: findings with exact file pointers + suggested `rg`/test commands
- Option B: patch limited to ownership + validation command(s)
```

- Assign clear ownership to avoid merge conflicts: only one agent edits a given file set at a time; other agents should produce findings, notes, or patches against different files.
- Default output preference: if the agent is unsure, it should return `rg` commands to run + file pointers rather than a speculative patch.
- Avoid expensive/slow work by default: sub-agents should not run `bun install` or full test suites unless explicitly requested. Prefer the smallest targeted build/test command that validates the scoped change.
- Keep spawned agents from idling: queue work in small chunks; use `functions.wait` with a bounded timeout to poll for results; redirect quickly with `functions.send_input` (set `interrupt: true` when needed); and call `functions.close_agent` once an agent has completed its scope.
- Prefer a hub-and-spoke workflow: continuously integrate results, adjust priorities, and keep agents fed with the next highest-value task until the overall goal is complete.
- Operating loop: spawn a small number of agents (start with 2-4); track `agent_id -> lane + next task`; `functions.wait` for updates; integrate results; immediately `functions.send_input` the next chunk; and `functions.close_agent` when a lane is done or blocked.
- Avoid tight polling: use `functions.wait` with timeouts in the 30-60s range; the runtime may enforce a minimum wait timeout.

## Review Guidelines

- Focus on correctness regressions, error handling, and missing tests.
- Treat bug fixes without regression tests as blocking unless explicitly justified.
- Flag infra changes in `argocd/`, `tofu/`, `kubernetes/`, or `ansible/` for rollout/impact notes.
- Treat security issues (secrets, auth gaps, PII logging) as highest priority.

## Merge Guidelines

- Use squash merges for pull requests.
- Always create new work branches from a fresh `main`
- Use `gh pr merge 2202 --squash -R proompteng/lab` (no `--delete-branch`; avoids worktree checkout conflicts).

## CI/CD

- Do not deploy services directly from local worktrees for normal changes; push commits and let CI/CD build, publish, and roll out.
- Wait until all checks are green before reporting that a PR is ready (example: `gh pr checks 2298 --watch -R proompteng/lab`).
- Before opening or updating a PR, ensure all mandatory checks are green and fix CI breakages (especially strict type-checks like Pyright) before requesting review or merge.
- Require linting in CI for each language path touched by the change (for example `oxfmt --check`/Oxlint for TS, `ruff` for Python, and service-specific Go linters as applicable).
- For `services/torghut` changes, do not claim type-checks are passing until all three CI pyright profiles pass locally:
  - `uv sync --frozen --extra dev`
  - `uv run --frozen pyright --project pyrightconfig.json`
  - `uv run --frozen pyright --project pyrightconfig.alpha.json`
  - `uv run --frozen pyright --project pyrightconfig.scripts.json`

## Generated Artifacts & Safety

- Do not edit generated directories (`dist/`, `build/`, `_generated`) or lockfiles (`bun.lock`, `bun.lockb`); regenerate via the owning tool.
- Default to GitOps (edit `argocd/` manifests and let Argo CD sync). Only apply directly to the cluster when explicitly asked or in an emergency, and document the deviation.
- Argo CD apps under `argocd/applications/**` should not include `Namespace` manifests; namespaces are created via ApplicationSet `CreateNamespace=true` and `managedNamespaceMetadata` (Pod Security labels, etc).
  - Upstream remote bases/releases often include `Namespace` objects; drop them from the rendered output (Kustomize `patches` with `$patch: delete`) so Argo applies namespace metadata from the ApplicationSet instead of owning the Namespace resource.
  - `$patch: delete` removes the object from Kustomize output; it does not delete the live Namespace (the only risk is Argo prune, so avoid pruning Namespaces or set `argocd.argoproj.io/sync-options: Prune=false` on the Namespace via `managedNamespaceMetadata.annotations`).
- Avoid introducing deprecated Kubernetes/KubeVirt features in new manifests; if a component warns a field/feature gate is deprecated, remove it unless there is a documented requirement.
- Talos machine configs: do not define multiple `machine.files` entries with the same `path`. Talos will fail `writeUserFiles` with `resource ... already exists`, which prevents CRI/Kubelet from coming up (often surfacing as `/etc/kubernetes/bootstrap-kubeconfig: read-only file system`). Multi-document machine configs are hard to surgically edit via patches; prefer generating/applying a corrected full config via `talosctl apply-config` if you need to remove a duplicate entry.

## Kubernetes (kubectl)

- Use explicit namespaces with kubectl (e.g., `kubectl get pods -n <ns>`).
- If `kubectl config current-context` is unset in this Coder workspace, bootstrap an `in-cluster` context using
  `/var/run/secrets/kubernetes.io/serviceaccount/{token,ca.crt,namespace}` with
  `https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}` before running cluster checks.
- If `kubectl` auth fails (`Unauthorized` / `You must be logged in to the server`), refresh the `service-user`
  credential from `/var/run/secrets/kubernetes.io/serviceaccount/token`, set the `in-cluster` CA from
  `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`, and verify with `kubectl auth whoami` before retrying.
- Helm charts present: run from `nix develop`, then `kustomize build --enable-helm <path> | kubectl apply -n <ns> -f -`.
- CNPG access: `kubectl cnpg psql -n <ns> <cluster> -- <psql args>` (psql flags after `--`).

## AgentRuns (agents namespace)

- Docs: `docs/agents/agentrun-creation-guide.md`, `docs/agents/crd-yaml-spec.md`, Torghut templates/safety: `docs/torghut/design-system/v1/agentruns-handoff.md`.
- Prompt precedence: avoid `AgentRun.spec.parameters.prompt` when referencing an ImplementationSpec (it overrides `ImplementationSpec.spec.text`).
- TTL: use top-level `AgentRun.spec.ttlSecondsAfterFinished` (do not rely on `spec.runtime.config` for TTL).
- PR/VCS runs: set `spec.vcsRef.name`, `spec.vcsPolicy` (read-write), and a unique `spec.parameters.head` branch (repo convention: `codex/...`).
- In-cluster callbacks/auth: default to service-account tokens from `/var/run/secrets/kubernetes.io/serviceaccount/token` when no explicit token is provided; for whitepaper finalize callbacks use `JANGAR_WHITEPAPER_FINALIZE_USE_SERVICE_ACCOUNT_TOKEN=true` (optional override path: `JANGAR_WHITEPAPER_SERVICE_ACCOUNT_TOKEN_PATH`).
- Verify after apply: inspect controller-generated ConfigMap labeled `agents.proompteng.ai/agent-run=<run-name>` and check `run.json.prompt`; if failing early, compare `agentrun.status.contract.requiredKeys` vs `spec.parameters`.
- Monitor: `kubectl -n agents get agentrun <name>`; `kubectl -n agents get job -l agents.proompteng.ai/agent-run=<name> -o name`; `kubectl -n agents logs -f job/<job-name>`.

## Temporal

- Temporal CLI usage, address, namespace, and task queue defaults live in `skills/temporal/SKILL.md` (source of truth).

## When in Doubt

- Check the nearest README for service-specific commands.
- Search internet with correct keyword and questions containing context using web.run.
