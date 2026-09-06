# Working in lab

Deliver the requested outcome with production-quality code and evidence that it works. Use engineering judgment to
choose the implementation. Preserve the user's scope, constraints, authorization, and definition of success throughout
the task.

## Work to completion

- Treat requests to build, change, fix, ship, or roll out as authorization to complete the in-scope work through
  delivery. Honor explicit limits such as local-only, draft-only, or do-not-deploy. Requests to explain, investigate,
  review, or plan call for findings unless the user also requests changes.
- Resolve routine choices from the code and conversation. Ask only when missing information materially changes the
  outcome or authority to act. Continue independent work while an answer is pending.
- Authorization persists across turns. In-scope delivery includes local changes and validation, commits, pushes,
  PR creation, CI and review fixes, merge after required gates pass, normal CI/CD and GitOps rollout, and live
  acceptance. Do not request approval again merely because an authorized step writes to an external system.
- Ask before actions outside the authorized scope, unrequested destructive actions, purchases, or changes to
  credential identity, destinations, or permissions. An authorized rollout includes renewing an expired credential
  for the same verified account through its existing secret-sync path. Prepare changes and validation first so any
  required approval concerns the remaining action.
- Carry the task through the authorized endpoint. Distinguish local implementation, PR readiness, merge, and
  deployment in status reports, and preserve their respective review, CI, ownership, and acceptance requirements.
- Incorporate corrections without dropping unfinished requirements. Answer side questions and resume the task unless
  the user redirects or cancels it. Keep a short plan for dependent work and update it when evidence changes.
- Stop when acceptance is met; do not invent follow-up work.

## Establish the facts

- Work in the provided checkout. Inspect its branch, commit, and dirty files before editing. Preserve unrelated work;
  do not create another worktree or repository copy unless requested.
- Read the nearest applicable `AGENTS.override.md` or `AGENTS.md` and component README. More specific repository
  instructions govern their paths. Explicit user instructions take precedence over repository and skill guidance,
  subject to system and developer constraints.
- Load skills that help the task. If a skill would cause an approval pause or prevent completion, check whether the
  conversation already authorizes the action. If the conflict remains, link and quote the exact instruction and
  explain its effect. Do not infer a new approval requirement from a general guideline.
- Use current source and configuration to establish intended behavior, and runtime evidence to establish deployed
  behavior. Follow [documentation authority](docs/documentation-authority.md) when sources disagree. Historical
  designs, memories, and healthy status indicators alone do not establish current correctness.
- Search with `rg` and `rg --files`. Batch independent reads, then follow relevant call paths and contracts. Begin
  implementation once the affected files, expected behavior, and validation path are clear. Search again when new
  evidence exposes an unknown.
- For indexed production `main`, use
  `bun run atlas:code-search --query "<query>" --repository proompteng/lab --limit 10`.
  Trust results only when relevant, without degradation, and matching the requested Git commit. Verify against fresh
  `origin/main`, or local `main` if no remote is configured. Otherwise treat results as navigation leads. Report
  contradictions and follow [Atlas's verification contract](docs/atlas/README.md); use Git and `rg` for branch changes.
- Before substantial investigation or implementation, retrieve focused context with
  `bun run --filter memories retrieve-memory --query "<task and identifiers>" --limit 10`.
  Verify important claims against current evidence. Unavailable memory is non-blocking. Save durable context only
  when explicitly requested; never save secrets, personal data, raw logs, or transient status.

## Implement the right change

- Fix the responsible code path. Model the domain and invariants before adding abstractions. Choose the simplest
  design that satisfies the complete requirement and fits the owning component.
- Trace affected callers and contracts. Update configuration, generated contracts, documentation, and consumers when
  behavior requires it. Preserve compatibility unless the task authorizes a breaking change.
- Use explicit types and control flow. Validate at trust boundaries, preserve error context, and handle failure
  paths. Do not conceal failures with fabricated data, silent fallbacks, disabled checks, or weakened assertions.
- Follow component conventions and authoritative formatter/linter configuration. For TypeScript, use
  [.oxfmtrc.json](.oxfmtrc.json) and [.oxlintrc.json](.oxlintrc.json). Use `gofmt` for Go, Ruff for Python, and the
  component's Kotlin, Rust, or Rails tooling where applicable.
- For UI work, use existing Tailwind and shadcn components, zinc colors, responsive layouts, and accessible states.
  Compose base components instead of modifying them. Forms use Zod, `zodResolver`, and inline validation errors.
- Change generators and source inputs, then regenerate output. Never hand-edit `dist/`, `build/`, `_generated`,
  generated routes, or dependency lockfiles. Add shadcn components through its CLI.

## Verify the outcome

- Reproduce defects when practical. For behavior fixes, add regression coverage that demonstrates the failure and
  passes with the change. If automation is impractical, record the reason and exact manual evidence.
- Run the smallest meaningful checks for changed behavior, plus required component and CI checks. Check failure
  paths and affected contracts in proportion to risk. Documentation and other low-impact edits need relevant
  validation, not tests that restate their contents.
- Inspect the resulting files and diff. A successful tool invocation does not prove the intended edit happened.
  Keep generated changes and unrelated files out of the patch unless required by the task.
- Distinguish product failures from missing dependencies, denied network operations, and unavailable environments.
  Report what ran, what passed, and what remains unverified. Never claim a blocked check passed.
- Once relevant checks pass, repeat or broaden them only after a change, failure, or unresolved concern justifies it.
- Review actionable issues introduced by the change. Prioritize correctness, authorization, data loss, exposed
  secrets, and personal data in logs. Leave formatting enforcement to the configured tools.
- For requested releases, verify the exact remote commit, required CI, deployed image/revision, and live behavior.
  Argo `Synced`/`Healthy` and readiness endpoints establish infrastructure state; exercise the requested product or
  runtime behavior before calling the release complete.

## Delegate and communicate

- Delegate independent work when it saves time or improves quality. Use `gpt-5.6-luna` with `max` reasoning for
  subagents. Give each a bounded objective, relevant context, exclusive file ownership or read-only scope,
  constraints, and expected evidence.
- Keep one owner for integration and final verification. Avoid concurrent writes to the same files. Do useful work
  locally while agents run; review their results before relying on them. Avoid duplicate discovery and broad suites.
- Keep communication concise and legible. Lead with the result or decision. Report meaningful findings, changed
  assumptions, and blockers; omit routine tool narration and repeated plans.
- Final responses state what changed, the validation and its outcome, and any remaining blocker or required action.
  Link relevant files. Distinguish implemented, tested, pushed, merged, and deployed claims.

## Repository navigation and commands

| Area                           | Starting point                                                       |
| ------------------------------ | -------------------------------------------------------------------- |
| Product apps and runtimes      | `apps/`, nearest README and `package.json`                           |
| Shared libraries, Convex, SDKs | `packages/`, especially `packages/backend/`                          |
| Backend services               | `services/`, owning README and language manifest                     |
| Infrastructure                 | `argocd/`, `kubernetes/`, `charts/`, `tofu/`, `ansible/`, `devices/` |
| Build and deployment helpers   | [packages/scripts/README.md](packages/scripts/README.md)             |
| Operational documentation      | [docs/README.md](docs/README.md)                                     |

Use `nix develop` for the repository toolchain and `toolchain-doctor` when versions differ. Read [flake.nix](flake.nix),
[package.json](package.json), and component manifests for current pins and scripts. Install workspace dependencies
with `bun install` when needed. Run the commands below from the repository root, passing root-relative `<paths>`.
Select workspace scripts with `--filter`; run component-only commands from their documented owning directory.

Common entry points, selected according to the change:

```sh
bun run --filter <workspace> <script>
bunx oxfmt --check <paths>
bunx oxlint --config .oxlintrc.json <paths>
bun run --filter @proompteng/backend codegen
bun run proto:generate
```

Run Go tests inside the affected module; the root `go.work` does not make `go test ./services/...` cover every module.
Use each service's documented test, lint, and build commands for other languages. Validate Argo manifests with
`bun run lint:argocd`. Follow [devices/galactic/README.md](devices/galactic/README.md) for the current Talos/Omni
cluster. Run OpenTofu or Ansible only from an explicitly selected, currently owned stack. Read deployment,
bootstrap, and reseal scripts before running them; they can modify live systems.

## Git and delivery

- For new work branches, use `codex/` from fresh `main`. Continue an assigned branch when provided. Preserve the
  supplied checkout and unrelated changes when selecting a branch.
- Use Conventional Commits and matching PR titles, `<type>(<scope>): <summary>`. Stage explicit owned paths;
  never use `git add -A` in a dirty shared checkout.
- Build PR bodies from [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md). Describe final behavior
  and actual validation, fill retained sections, and remove placeholders.
- Validate locally before pushing. Resolve required CI failures before claiming readiness or merging. Ensure touched
  code has appropriate language lint checks. Verify CI against the current PR commit.
- Let automatic Codex review run. Do not post `@codex review` or repeatedly poll for review signals. Verify actionable
  findings, fix them, add focused evidence, and push before replying and resolving. A fix push does not require a new
  review cycle, but unresolved actionable findings block merge.
- Use GitHub native stacks for dependent PRs. Verify parent relationships with `gh stack view` and keep each layer
  independently reviewable and green. When publication is authorized, use `gh stack submit --auto --open`.
- When merge is authorized, squash with `gh pr merge <number> --squash -R proompteng/lab`, or
  `gh stack merge --yes --squash` for a green stack. Do not delete branches used by shared worktrees.

## Infrastructure invariants

- Normal deployments use committed CI/CD and GitOps. Edit desired state and let Argo reconcile. Direct cluster
  mutation requires explicit authorization or an authorized emergency procedure; do not deploy from a worktree.
- For infrastructure changes, record rollout order, impact, and recovery. Render and validate manifests before any
  authorized apply. Use Helm 3 through `nix develop` for `kustomize build --enable-helm`; Helm 4 is unsupported here.
- Confirm the target context and always pass an explicit namespace to `kubectl`. On authorization failures, verify
  identity and follow the [access runbook](docs/runbooks/galactic-kubernetes-access.md) within the user's authority;
  do not silently change credentials or targets.
- If Coder has no context, configure `in-cluster` using its mounted
  `/var/run/secrets/kubernetes.io/serviceaccount/{token,ca.crt,namespace}` and
  `https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}`. Verify identity with
  `kubectl -n <ns> auth whoami` before cluster operations. Keep token contents out of output.
- Application image delivery is owned by Kargo. The normal path is `main` merge -> passing image build/publish -> Kargo Warehouse -> Freight -> exact automatic Stage promotion -> Kargo copies the exact source commit, writes the full digest and build/provenance metadata, and pushes `kargo/<stage>` -> Argo CD sync/health -> workload rollout and live proof. Retained post-deploy workflows listen to that exact Kargo branch and the Stage-written manifest paths, not `main`; manual dispatch is diagnostic only. Do not create or merge a SHA/digest manifest bump, release branch, deployment PR, release automerge, manual Argo sync, or direct `kubectl` deployment for an image release.
- Repo-owned builders publish immutable `kargo-sha-<40>` aliases only after the final multi-architecture OCI index succeeds. Multi-image receipt builders must withhold all discoverable Kargo aliases until every image and the caller's terminal validation and artifact upload succeed; they may prepare exact receipt indexes under tags excluded by the Warehouse. Images retaining CI receipts use `kargo-sha-<40>-run-<github-run-id>`, so a new build run for the same source never moves an immutable tag. Platform images carry `org.opencontainers.image.created` and `org.opencontainers.image.revision`; the final index carries stable source/revision annotations, while receipt-bearing indexes also carry `ai.proompteng.github-actions-run-id` and `ai.proompteng.github-actions-build-conclusion`. The builder must reject mismatched run-qualified tags and annotations. Kargo-retained CI receipts must come from those selected-image annotations, never a Freight name or invented result. Their Warehouses ignore legacy `sha-*` and mutable `latest`, preventing failed or pre-migration builds from creating Freight. External `analysis` uses publisher `latest` only as a `Digest`-strategy discovery pointer and pins the immutable digest in Freight/manifests; external `bilig` uses bare 40-hex/`NewestBuild`. Agents and operators never create or retag these tags.
- Git remains the complete desired-state authority; Kargo Freight and Stage state plus its generated `kargo/<stage>` branch are the promotion record. ApplicationSet must track and preserve Kargo branches and their deployment metadata, and a recreated Application is recovered by re-promoting its current Freight. Use the `lab-delivery` namespace for Warehouse/Freight/Stage evidence and `argocd` for Application evidence.
- New Kargo targets require a main-only build that publishes an immutable image, a Warehouse, Stage, exact automatic promotion policy, and the Application's authorized-stage annotation. Promotion must update the source files consumed by the Application's configured renderer; validate the rendered output against the promoted digest. Do not assume built-in Kustomize or forbid an existing renderer such as Lovely.
- Bayn is the explicit safety exception and is not enrolled in Kargo: it has no Warehouse, Freight, or Stage. `bayn-release` activation and lineage remain the authority for strategy activation.
- Applications under `argocd/applications/**` must not render `Namespace` objects. ApplicationSet owns namespaces
  through `CreateNamespace=true` and `managedNamespaceMetadata`. Remove upstream namespace manifests with a
  Kustomize `$patch: delete`; this changes rendered output, not the live namespace. Prevent namespace pruning.
- Talos configurations must have unique `machine.files[].path` entries. Duplicate paths can prevent CRI and Kubelet
  startup. Correct and validate the full configuration before an authorized apply. Avoid deprecated Kubernetes and
  KubeVirt fields or feature gates without a documented requirement.
- For AgentRuns, read the [creation guide](docs/agents/agentrun-creation-guide.md) and
  [CRD specification](docs/agents/crd-yaml-spec.md). Do not set `spec.parameters.prompt` with an ImplementationSpec;
  it overrides the intended text. Verify the rendered controller `run.json.prompt` and required contract keys after
  creation. Use top-level `spec.ttlSecondsAfterFinished` and the documented VCS and service-account contracts.
- For Temporal operations, use [skills/temporal/SKILL.md](skills/temporal/SKILL.md) for address, namespace, and task
  queue defaults.

## Guidance sources

This guide applies OpenAI's GPT-6 Astra recommendations to this repository. The delegation model and repository
policies above are local choices. Model and reasoning settings belong in the active runtime configuration; this file
does not migrate application model defaults.

- [GPT-6 Astra prompting guidance](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#prompting-best-practices), consulted 2026-09-05.
- [Codex AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md), consulted 2026-09-05.
