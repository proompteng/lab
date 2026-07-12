# Repository Agent Guide

## Operating Contract

- Work from the requested outcome. Infer ordinary implementation details from context, preserve explicit constraints, required evidence, success criteria, and output format, and ask only when a material ambiguity could change the outcome, risk, or approval boundary.
- For review, explanation, diagnosis, or planning requests, inspect and report without changing state. For build, fix, or change requests, make in-scope local edits and run relevant non-destructive validation. Reading, searching, inspecting logs, editing in-scope code, and running local tests are pre-approved.
- Require confirmation for destructive actions, external writes not inherent to the requested workflow, purchases, credential or permission changes, and material scope expansion.
- Complete the requested outcome before yielding. For multi-step work, keep a short plan, update it only at meaningful milestones, and avoid narrating routine tool use.
- Start from concrete evidence and reproduce defects when practical. Gather context until you can name the files or resources to change and the validation path, then act without repeating equivalent searches or reads.
- Lead final responses with the result, evidence, validation commands and outcomes, material caveats or blockers, and the next required action. Omit repeated background and generic reassurance.
- Check the nearest `README` or nested `AGENTS.md` for component-specific rules.

## Repository Map

- `apps/`: Next.js and TanStack frontends; tests are co-located.
- `packages/`: shared TypeScript libraries and the Convex backend in `packages/backend`.
- `services/`: Go, Kotlin, Rails, and Python services.
- `argocd/`, `kubernetes/`, `tofu/`, `ansible/`: infrastructure and GitOps.
- `scripts/`, `packages/scripts/`: build and typed deployment helpers.
- `skills/`: agent skills; bootstrap with `scripts/init_skill.py`.

## Toolchain

- Prefer `nix develop` from the repository root. Run `toolchain-doctor` inside the shell when versions look wrong.
- Pinned versions: Node 24.11.1, Bun 1.3.14, Go 1.25.5, Ruby 3.4.7 with Bundler 2.7+, and Helm 3. Go services support Go 1.24+.
- Python support: 3.9–3.12 for `apps/alchimie`; 3.11–3.12 for `services/torghut`.
- Helm 4 is not supported for `kustomize --enable-helm` in this repository.
- Optional local direnv setup: copy `.envrc.example` to `.envrc`, then run `direnv allow`.
- Do not edit generated output (`dist/`, `build/`, `_generated`) or lockfiles (`bun.lock`, `bun.lockb`) directly; use the owning generator.

## Discovery and Commands

- Search code with `bun run atlas:code-search --query "<query>" --repository proompteng/lab --limit 10`. Narrow only as needed with `--path-prefix`, `--language`, then `--ref`.
- Install dependencies with `bun install`.
- Frontends: `bun run dev:<app>`, `bun run build:<app>`, `bun run start:<app>`.
- Convex: `bun run dev:convex`, `bun run --filter @proompteng/backend codegen`, `bun run seed:models`.
- TypeScript formatting and linting: `bun run format`, `bun run lint:<name>`, `bunx oxfmt --check <paths>`.
- Protobufs: `bun run proto:generate`.
- Go: `go test ./services/...`, `go build ./services/...`; run `go mod tidy` in a service when dependencies change.
- Infrastructure: `bun run tf:plan`, `bun run tf:apply`, `bun run lint:argocd`, `bun run ansible`.
- Scope workspace commands with `bun run --filter <workspace> <script>`.
- Focused tests: `bun run --filter <workspace> test -- <file> -t "<name>"`, `bun test -t "<name>" <file>`, `go test ./services/prt -run <TestName>`, `./gradlew test --tests "<class>"`, `bundle exec rails test <file>:<line>`, or `pytest <file> -k "<pattern>"`.

## Memory Workflow

- Before substantial investigation or implementation, retrieve relevant prior context from the repository root with `bun run --filter memories retrieve-memory --query "<task, service, and relevant identifiers>" --limit 10`.
- Retrieval searches all namespaces by default. Add `--task-name "<namespace>"` only when intentionally restricting the search to one stable namespace.
- Treat retrieved memories as leads, not authority. Verify important claims against the current branch, current documentation, or live state before acting.
- After completing work, save a memory only when it contains durable context that will materially help future tasks, such as architectural decisions, discovered constraints, operational facts, or important identifiers. Use `bun run --filter memories save-memory --task-name "<stable-namespace>" --content "<durable context>" --summary "<short summary>" --tags "<comma-separated-tags>"`.
- Do not save secrets, credentials, access tokens, private user data, raw logs, transient CI or rollout status, speculative conclusions, or facts that are easily rediscovered without added context.
- In agents-shell and other Kubernetes workloads, the scripts auto-detect the in-cluster Agents endpoint. Memory unavailability is non-blocking unless the task explicitly depends on it.

## Code Standards

- Oxfmt is authoritative: 2 spaces, single quotes, trailing commas, 120-column width.
- Imports: standard library, third party, then internal, separated by blank lines.
- Names: `kebab-case` files, `PascalCase` components and types, `camelCase` functions.
- Prefer explicit control flow over nested ternaries and use `async`/`await` consistently.
- Go: run `gofmt`; wrap errors with context using `fmt.Errorf("context: %w", err)`.
- Kotlin: run `ktlint`. Rails follows its default style.
- UI: Tailwind only; order classes layout → spacing → sizing → typography → colors and use `cn()` for conditionals.
- Use the zinc palette, responsive utilities, accessible interaction states, and content-driven dimensions rather than hardcoded widths or heights.
- Forms use Zod schemas in `schemas/`, `zodResolver`, validation after typing, and inline errors.
- Compose or configure base shadcn components; do not edit them directly. Add components through the shadcn CLI.

## Testing and Review

- Co-locate tests using `*.test.ts(x)`, `*_test.go`, `src/test/kotlin/*Test.kt`, Rails `test/**`, or `alchimie_tests/`.
- Run the smallest test that proves the behavior, then broaden validation in proportion to risk.
- Bug fixes require a regression test that fails before the fix and passes after it. If that is not feasible, document why and record exact manual validation.
- Review only actionable issues introduced by the change. Prioritize correctness, security, data loss, error handling, performance, and missing tests; avoid speculative or stylistic findings.
- Treat exposed secrets, authorization gaps, and PII logging as highest priority.
- Infra changes under `argocd/`, `kubernetes/`, `tofu/`, or `ansible/` require rollout and impact notes.

## Git, Pull Requests, and CI

- Create work branches from fresh `main` using the `codex/` prefix.
- Use Conventional Commits and matching PR titles: `<type>(<scope>): <summary>`. Common types are `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, and `revert`.
- Build every PR body from `.github/PULL_REQUEST_TEMPLATE.md`. Describe only actual changes, fill each retained section, use `N/A` where appropriate, check completed checklist items, and remove placeholders or duplicate sections before create or update.
- Run focused local validation before pushing. Fix all required CI failures before reporting the PR ready or merging.
- Ensure CI provides language-appropriate linting for every touched path: Oxlint/Oxfmt for TypeScript, Ruff for Python, and the service-specific Go linter where applicable.
- For `services/torghut`, run all required type checks before claiming success:
  - `uv sync --frozen --extra dev`
  - `uv run --frozen pyright --project pyrightconfig.json`
  - `uv run --frozen pyright --project pyrightconfig.alpha.json`
  - `uv run --frozen pyright --project pyrightconfig.scripts.json`
- Use squash merges: `gh pr merge <number> --squash -R proompteng/lab`. Do not pass `--delete-branch`, which conflicts with worktrees.
- Normal deployments flow through committed CI/CD and GitOps; do not deploy services directly from a worktree.

## Codex Review Gate

- Automatic Codex review is required alongside CI. Let it start automatically; do not post `@codex review`.
- After CI finishes, poll every 30–60 seconds for the current head SHA and signals from `chatgpt-codex-connector[bot]`: PR reactions, submitted reviews, and inline findings.
- `eyes` means review is running. A `+1` created after the current head commit means review completed without blocking findings unless Codex also posted an actionable finding. Signals that predate the current head are stale.
- For each actionable finding, verify the cited code and range, fix it, add focused regression coverage or exact validation, then push. Reply with the commit and evidence and resolve the finding only after the fix is present.
- A new push resets the review gate. Merge only when required CI is green, the PR is mergeable, Codex completed review of the current head, and no blocking finding remains.

## Sub-agents

- Use sub-agents only for independent parallel work. Give each one a concrete objective, exclusive file ownership or a read-only scope, constraints, and expected evidence.
- Keep one decision owner. Do not let agents edit overlapping files; prefer findings with exact pointers when ownership is uncertain.
- Avoid expensive installs and full suites in delegated discovery. Use targeted validation, 30–60 second waits, and close completed agents promptly.

## GitOps and Infrastructure Safety

- Default to GitOps: edit manifests and let Argo CD reconcile. Apply directly only when explicitly requested or during a documented emergency.
- Argo applications under `argocd/applications/**` must not render `Namespace` objects. ApplicationSet owns namespaces through `CreateNamespace=true` and `managedNamespaceMetadata`.
- Remove upstream `Namespace` objects with a Kustomize `$patch: delete`; this removes them from rendered output, not from the cluster. Avoid namespace pruning or set `argocd.argoproj.io/sync-options: Prune=false` through managed namespace annotations.
- Do not introduce deprecated Kubernetes or KubeVirt fields or feature gates without a documented requirement.
- Talos configs must not contain duplicate `machine.files[].path` values. Duplicate paths break `writeUserFiles` and can prevent CRI and Kubelet startup. For multi-document configs, generate and apply a corrected full config rather than attempting a fragile patch.

## Kubernetes

- Always pass an explicit namespace to `kubectl`.
- If no context exists in Coder, create an `in-cluster` context from `/var/run/secrets/kubernetes.io/serviceaccount/{token,ca.crt,namespace}` and `https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}`.
- On `Unauthorized` or login errors, refresh the `service-user` token and in-cluster CA, then verify with `kubectl auth whoami` before retrying.
- Render Helm-backed Kustomize overlays from `nix develop`: `kustomize build --enable-helm <path> | kubectl apply -n <ns> -f -`.
- CNPG: `kubectl cnpg psql -n <ns> <cluster> -- <psql args>`.

## AgentRuns

- Sources of truth: `docs/agents/agentrun-creation-guide.md`, `docs/agents/crd-yaml-spec.md`, and `docs/torghut/design-system/v1/agentruns-handoff.md`.
- When using an ImplementationSpec, omit `spec.parameters.prompt`; it overrides `ImplementationSpec.spec.text`.
- Set TTL with top-level `spec.ttlSecondsAfterFinished`.
- PR/VCS runs require `spec.vcsRef.name`, read-write `spec.vcsPolicy`, and a unique `spec.parameters.head` using `codex/...`.
- Default in-cluster callbacks to the service-account token. Whitepaper finalize callbacks use `JANGAR_WHITEPAPER_FINALIZE_USE_SERVICE_ACCOUNT_TOKEN=true`; override the path with `JANGAR_WHITEPAPER_SERVICE_ACCOUNT_TOKEN_PATH` only when needed.
- After apply, inspect the controller ConfigMap labeled `agents.proompteng.ai/agent-run=<name>` and verify `run.json.prompt`. For early failures, compare `status.contract.requiredKeys` with `spec.parameters`.
- Monitor with `kubectl -n agents get agentrun <name>`, `kubectl -n agents get job -l agents.proompteng.ai/agent-run=<name> -o name`, and `kubectl -n agents logs -f job/<job>`.

## Temporal

- Use `skills/temporal/SKILL.md` as the source of truth for Temporal CLI address, namespace, and task queue defaults.
