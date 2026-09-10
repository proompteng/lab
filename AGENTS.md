# Working in lab

Complete the requested change, prove it at the requested boundary, and stop. Prefer the smallest design that satisfies
all requirements. Spend time and tokens on decisions, implementation, and evidence that affect the outcome.

## Scope and authority

- Work directly. Do not spawn subagents.
- Requests to build, change, fix, or ship authorize implementation, validation, commit, push, PR, CI and review fixes,
  and merge after required gates pass. Respect narrower limits such as local-only, draft-only, or do-not-deploy.
  Investigation, review, explanation, and planning requests authorize findings unless the user also requests changes.
- Authorization persists across turns. Resolve routine choices from the repository and conversation. Ask only when
  missing information changes the outcome or authority to act, and continue independent work while waiting.
- Ask before expanding scope, unrequested destructive actions, purchases, or changes to credential identity,
  destinations, or permissions. An authorized rollout includes renewing an expired credential for the same verified
  account through its existing secret-sync path. Prepare the reviewable work before any required approval.
- Confirm a successful merge, report it, and stop. Deployment, post-merge CI monitoring, Kargo/Argo monitoring, and live
  verification require an explicit request. A routine fix, ship, or merge request ends at reviewed merge.
- Preserve unfinished requirements when the user adds feedback. Answer side questions and resume unless redirected.
  Do not turn completion into another cleanup, audit, or monitoring task.

Explicit user instructions take precedence over repository and skill guidance, subject to system and developer
constraints. Read applicable instructions along the path to files you change and the owning component's README.
`AGENTS.override.md` takes precedence over `AGENTS.md` in the same directory; more specific instructions govern their
paths. Use skills when they help. If a skill blocks authorized work, check existing authorization before asking; if a
conflict remains, link and quote the exact instruction and explain its effect.

## Establish enough evidence to act

1. Inspect the provided checkout's branch, commit, and dirty files. Preserve unrelated work. Do not create another
   worktree or repository copy unless requested. Continue an assigned branch; start new work on `codex/` from fresh
   `origin/main`, or local `main` when no remote is configured, without overwriting local changes.
2. Identify expected behavior, the responsible code path, affected callers and contracts, and the validation needed
   to prove the change. Keep a short plan only when dependent steps need tracking.
3. Use `rg` and `rg --files` for focused discovery. Batch independent reads. Begin implementation once the affected
   files and validation path are clear; expand investigation only when evidence exposes an unresolved question.
4. Use source and configuration for intended behavior, runtime readback for deployed behavior, and
   [documentation authority](docs/documentation-authority.md) when sources disagree. Historical designs, memory,
   search indexes, and health indicators alone do not establish current correctness.

Before substantial investigation or implementation, retrieve focused context:

```sh
bun run --filter memories retrieve-memory --query "<task and identifiers>" --limit 10
```

Verify important claims against current evidence. Unavailable memory is non-blocking. Save durable context only when
explicitly requested; never save secrets, personal data, raw logs, or transient status.

For indexed production `main`, use:

```sh
bun run atlas:code-search --query "<query>" --repository proompteng/lab --limit 10
```

Trust results only when relevant, without degradation, and matching the requested commit verified against fresh
`origin/main`, or local `main` without a remote. Otherwise use them as navigation leads. Follow
[Atlas's verification contract](docs/atlas/README.md), report contradictions, and use Git and `rg` for branch changes.

## Make the responsible change

- Model the domain and invariants before adding abstractions. Fix the owning code path and choose explicit types and
  control flow that fit the component. Avoid unrelated refactors and speculative infrastructure.
- Update affected callers, configuration, documentation, and generated contracts together. Preserve compatibility
  unless a breaking change is authorized. Validate at trust boundaries and retain useful error context.
- Handle failure paths. Do not hide failures with fabricated data, silent fallbacks, disabled checks, or weaker
  assertions. Keep secrets and personal data out of logs and committed artifacts.
- Follow the configured formatter and linter. TypeScript uses [.oxfmtrc.json](.oxfmtrc.json) and
  [.oxlintrc.json](.oxlintrc.json); Go uses `gofmt`, Python uses Ruff, and other languages use the owning component's
  tooling.
- For UI work, compose existing Tailwind and shadcn components with zinc colors, responsive layouts, and accessible
  interaction states. Add shadcn components through its CLI; do not modify base components. Forms use Zod,
  `zodResolver`, and inline validation errors.
- Edit generator inputs, then regenerate outputs. Use the owning package manager for lockfiles. Do not hand-edit
  `dist/`, `build/`, `_generated`, generated routes, or dependency lockfiles.

## Prove the result

- Reproduce a defect when practical. Add regression coverage for behavior fixes that fails before the fix and passes
  afterward. If automation is impractical, give the reason and exact manual evidence.
- Run the smallest meaningful checks for affected behavior and failure paths, plus required component and CI checks.
  Documentation and low-impact edits need relevant validation, not tests that restate the edit.
- Inspect the final files and diff. Keep unrelated and unnecessary generated changes out of the patch. Repeat or
  broaden checks only after a change, failure, or unresolved concern justifies it.
- Separate product failures from missing dependencies, denied network operations, and unavailable environments.
  Report what passed, what failed, and what remains unverified. A blocked check has not passed.
- For explicitly requested deployment or production verification, verify the exact remote commit, CI, deployed
  revision/image, and requested live behavior. Argo `Synced`/`Healthy` and readiness endpoints establish infrastructure
  state; exercise the product behavior before claiming the release is complete.

## Code Review Rules

Flag actionable defects introduced by the change, especially incorrect behavior, broken contracts, authorization
errors, data loss, exposed secrets, and personal data in logs. Explain the concrete trigger and consequence. Leave
formatting and lint enforcement to configured tools. Do not expand a focused review into unrelated cleanup.

## Deliver through the existing gates

- Use Conventional Commits and matching PR titles, `<type>(<scope>): <summary>`. Stage explicit owned paths; never use
  `git add -A` in a dirty shared checkout.
- Build PR descriptions from [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md). Describe final
  behavior and actual validation, fill retained sections, and remove placeholders.
- Validate locally before pushing. Resolve required CI failures and check results against the current PR commit.
- Let automatic Codex review run. Do not post `@codex review` or repeatedly poll for review signals. Verify actionable
  findings, fix them, add focused evidence, and push before replying and resolving. A fix push does not require a new
  review cycle; unresolved actionable findings block merge.
- Use GitHub native stacks for dependent PRs. Verify parent relationships with `gh stack view`, keep each layer
  independently reviewable and green, and publish with `gh stack submit --auto --open` when authorized.
- Squash with `gh pr merge <number> --squash -R proompteng/lab`, or `gh stack merge --yes --squash` for a green stack.
  Do not delete branches used by shared worktrees. Confirm the merged state and stop at the authorized boundary.

## Repository tools and entry points

Use `nix develop` for the pinned toolchain and `toolchain-doctor` when versions differ. Read [flake.nix](flake.nix),
[package.json](package.json), and component manifests for current pins and scripts. Use `bun install` when dependencies
are needed. Run these commands from the repository root with root-relative `<paths>`, selecting only relevant checks:

```sh
bun run --filter <workspace> <script>
bunx oxfmt --check <paths>
bunx oxlint --config .oxlintrc.json <paths>
bun run --filter @proompteng/backend codegen
bun run proto:generate
bun run lint:argocd
```

Run component-only commands from their documented directory. Run Go tests inside the affected module; root `go.work`
does not make `go test ./services/...` cover every module.

| Work                              | Start here                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Apps, services, shared packages   | `apps/`, `services/`, `packages/`; owning README and manifest                                               |
| Convex                            | `packages/backend/`                                                                                         |
| Build and deployment helpers      | [packages/scripts/README.md](packages/scripts/README.md)                                                    |
| Operational documentation         | [docs/README.md](docs/README.md)                                                                            |
| Talos/Omni and cluster operations | [devices/galactic/README.md](devices/galactic/README.md)                                                    |
| Image delivery                    | [docs/release-automation.md](docs/release-automation.md)                                                    |
| AgentRuns                         | [creation guide](docs/agents/agentrun-creation-guide.md), [CRD specification](docs/agents/crd-yaml-spec.md) |
| Temporal                          | [skills/temporal/SKILL.md](skills/temporal/SKILL.md)                                                        |

## Infrastructure contracts

Read deployment, bootstrap, and reseal scripts before running them. Run OpenTofu and Ansible only from an explicitly
selected, currently owned stack. Record rollout order, impact, and recovery for infrastructure changes; render and
validate manifests before an authorized apply.

- Normal deployments use committed CI/CD and GitOps. Direct cluster mutation requires explicit authorization or an
  authorized emergency procedure. Do not deploy from a worktree or use legacy direct-cluster helpers for releases.
- Kargo owns application image promotion. Follow [release automation](docs/release-automation.md) for artifact
  eligibility, enrollment, promotion, evidence, and recovery. The path is reviewed `main` merge, successful immutable
  image publication, Warehouse/Freight, exact automatic Stage promotion, generated `kargo/<stage>`, Argo reconciliation,
  workload rollout, and live proof. Do not bypass gates with SHA/digest bumps, release branches, deployment PRs,
  release automerge, manual Argo sync, direct `kubectl` deployment, or operator-created/retagged image aliases.
- Preserve the release contract's OCI annotations, immutable and run-qualified tags, and external `analysis`/`bilig`
  exceptions. CI receipts come from the selected image's annotations. Multi-image receipt builders withhold every
  discoverable Kargo alias until all images, terminal validation, and artifact uploads succeed; preparation tags must
  remain excluded from Warehouse discovery.
- Git owns desired state. Kargo Freight, Stage, and `kargo/<stage>` record promotion. ApplicationSet must preserve the
  Kargo branch and deployment metadata; recover a recreated Application by re-promoting its current Freight. New
  targets need a main-only immutable build, Warehouse, Stage, exact automatic policy, and authorized-stage annotation.
  Promotion must update the configured renderer's source inputs, with rendered output verified against the digest.
  Retained post-deploy workflows follow the exact Kargo branch and Stage-written paths; manual dispatch is diagnostic.
  Use `lab-delivery` for promotion evidence and `argocd` for Application evidence.
- Bayn is outside Kargo. It has no Warehouse, Freight, or Stage. `bayn-release` activation and lineage remain the
  authority for strategy activation.
- Confirm the Kubernetes context and pass an explicit namespace to `kubectl`. On authorization failures, verify
  identity and follow the [access runbook](docs/runbooks/galactic-kubernetes-access.md) without silently changing
  credentials or targets. If Coder has no context, configure `in-cluster` from its mounted service account files at
  `/var/run/secrets/kubernetes.io/serviceaccount/{token,ca.crt,namespace}` and
  `https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}`. Verify with `kubectl -n <ns> auth whoami`; never print tokens.
- Use Helm 3 through `nix develop` for `kustomize build --enable-helm`; Helm 4 is unsupported here. Applications under
  `argocd/applications/**` must not render `Namespace` objects. ApplicationSet owns them through `CreateNamespace=true`
  and `managedNamespaceMetadata`. Delete upstream namespace manifests from rendered output with `$patch: delete`, and
  prevent live namespace pruning.
- Talos `machine.files[].path` entries must be unique. Validate the full configuration before an authorized apply.
  Avoid deprecated Kubernetes/KubeVirt fields or feature gates without a documented requirement.
- AgentRun task text belongs in the ImplementationSpec or inline implementation. `parameters.prompt` overrides are
  rejected. Follow the creation guide's VCS and service-account contracts, use top-level `spec.ttlSecondsAfterFinished`,
  and verify the controller's rendered `run.json.prompt` and required contract keys after creation.

## Communication and maintenance

Lead updates with the result, decision, or blocker. Keep them concise and omit routine tool narration. Final responses
state what changed, the validation result, and any remaining blocker; link relevant files and distinguish implemented,
tested, pushed, merged, and deployed claims.

Keep this file focused on repository-wide decisions and constraints. Put component procedures in their owning docs and
link them here. Verify changes against fresh `main` so a rewrite does not discard newer contracts. Model and reasoning
settings belong in runtime configuration, not application defaults changed by this guide.

Instruction scoping follows [Codex AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
consulted 2026-09-10. Repository policies above are local choices.
