# Version Control Provider Design

Status: Draft (2026-02-03)

## Problem
Today GitHub credentials are implicitly assumed in multiple places (environment variables, secrets, and examples), but there is no explicit model for a version control provider. This couples the control plane and chart deployments to GitHub and makes it hard to:
- Run agents without version control access.
- Support other VCS backends (GitLab, Bitbucket, Gitea, on-prem Git).
- Enforce consistent repository allowlists and permissions per environment.
- Reason about when a run should fail versus degrade to a non-push flow.

ImplementationSource models issue intake (GitHub/Linear), but version control operations (clone, commit, push, PR) are handled implicitly and out-of-band. These are different concerns and must be modeled separately.

## Goals
- Introduce a first-class VersionControlProvider concept for repo operations.
- Decouple issue intake (ImplementationSource) from VCS operations.
- Allow runs to succeed without VCS credentials unless explicitly required.
- Provide a consistent authorization model using existing SecretBinding policy.
- Keep the chart provider-agnostic and avoid hard-coded GitHub defaults.

## Non-goals
- Implementing new VCS backends in this document.
- Replacing Git tooling inside agent images.
- Modeling CI/CD or build pipelines.
- Changing the semantics of ImplementationSource providers.

## Current State (from code)
- ImplementationSource supports `github` and `linear` only, with `auth.secretRef` required in the CRD schema.
- ImplementationSpec `spec.source.provider` supports `github | linear | manual | custom`.
- The agent runtime expects GitHub token environment variables (`GITHUB_TOKEN` / `GH_TOKEN`) and uses `GIT_ASKPASS` when a token is present.
- SecretBinding is enforced whenever secrets are requested, so VCS credentials must be allowed by policy before a run can use them.

These behaviors should remain compatible while making the VCS provider explicit.

## Concept
The system should treat "issue intake" and "version control" as independent providers:
- ImplementationSource handles inbound issue data (GitHub, Linear).
- VersionControlProvider handles outbound repo operations (clone, commit, push, PR).

This allows any combination (Linear issues + GitHub repo, GitHub issues + GitLab repo, manual spec + local git, etc.).

## API Design

### New CRD: VersionControlProvider
Group: `agents.proompteng.ai` (consistent with existing CRDs)
Kind: `VersionControlProvider`
Plural: `versioncontrolproviders`

Spec (proposed):
- `provider`: `github | gitlab | bitbucket | gitea | generic`
- `apiBaseUrl`: base URL for provider API (optional for generic)
- `cloneBaseUrl`: base URL for clone URLs (https/ssh)
- `webBaseUrl`: base URL for repository links
- `auth`:
  - `method`: `token | app | ssh | none`
  - `token`:
    - `secretRef`: `{ name, key }`
    - `type`: `pat | fine_grained | api_token | access_token` (informational)
  - `app` (provider-specific, used for GitHub Apps):
    - `appId`: integer or string
    - `installationId`: integer or string
    - `privateKeySecretRef`: `{ name, key }`
    - `tokenTtlSeconds`: optional override (default 3600)
  - `ssh`:
    - `privateKeySecretRef`: `{ name, key }`
    - `knownHostsConfigMapRef`: `{ name, key }` (optional)
  - `username`: optional username for HTTPS auth
- `repositoryPolicy`:
  - `allow`: list of `owner/repo` or glob patterns
  - `deny`: list of `owner/repo` or glob patterns
- `capabilities`:
  - `read`: boolean
  - `write`: boolean
  - `pullRequests`: boolean
- `defaults`:
  - `baseBranch`: string
  - `branchTemplate`: string (e.g. `codex/{{issueNumber}}`)
  - `commitAuthorName`: string
  - `commitAuthorEmail`: string
  - `pullRequest`:
    - `enabled`: boolean
    - `draft`: boolean
    - `titleTemplate`: string
    - `bodyTemplate`: string

Status (proposed):
- `conditions`: Ready/InvalidSpec/AuthFailed
- `lastValidatedAt`

### References in existing CRDs
Add optional references to bind runs to a provider:
- `Agent.spec.vcsRef.name`
- `ImplementationSpec.spec.vcsRef.name` (optional; used when issue intake maps to a repo)
- `AgentRun.spec.vcsRef.name`

Resolution order (highest to lowest priority):
1. `AgentRun.spec.vcsRef`
2. `ImplementationSpec.spec.vcsRef`
3. `Agent.spec.vcsRef`
4. None (no VCS provider)

### Run-level VCS policy
Add a run-level policy to control behavior when VCS is unavailable:
- `AgentRun.spec.vcsPolicy.required`: boolean
- `AgentRun.spec.vcsPolicy.mode`: `read-write | read-only | none`

Behavior:
- If `required=true` and no provider or auth is missing, the run fails with `MissingVcsProvider`.
- If `required=false`, the run proceeds without push/PR creation. Artifacts are still produced locally.

## Controller Behavior
The controller should:
1. Resolve the VCS provider using the reference order above.
2. Validate provider availability and policy (allowlist, capabilities).
3. Populate runtime env or config with VCS settings (base URLs, auth paths, branch defaults).
4. If a provider has `auth.secretRef`, ensure the run has access via SecretBinding.
5. Respect `vcsPolicy.required` and mark runs appropriately.

Suggested condition reasons:
- `MissingVcsProvider`
- `VcsAuthUnavailable`
- `VcsPolicyDenied`
- `VcsSkipped` (run executed without VCS write access)

## Runtime Environment Mapping
For compatibility with existing agent images:
- When `provider=github` and `auth.method=token`, map to `GITHUB_TOKEN` / `GH_TOKEN`.
- When `auth.method=app`, mint a short-lived token and export it as `GITHUB_TOKEN`.
- Provide standardized env vars for all providers:
  - `VCS_PROVIDER`
  - `VCS_API_BASE_URL`
  - `VCS_CLONE_BASE_URL`
  - `VCS_WEB_BASE_URL`
  - `VCS_REPOSITORY`
  - `VCS_BASE_BRANCH`
  - `VCS_HEAD_BRANCH`
  - `VCS_TOKEN_PATH` (if mounted from a secret)
  - `VCS_SSH_KEY_PATH` (if SSH)

This keeps GitHub-specific tooling working while allowing multi-provider behavior.

## SecretBinding Integration
When a provider uses a secret, that secret must be allowed by SecretBinding for the Agent. The controller should:
- Add the provider secret to the run’s required secrets if not already present.
- Enforce existing SecretBinding policy checks.
- Fail only if `vcsPolicy.required=true`.

## Provider-Specific Guidance (from research)

### GitHub
- GitHub Apps require minting installation access tokens from a JWT; installation tokens expire after ~1 hour and can be scoped to specific repos and permissions.
- Webhook signing uses `X-Hub-Signature-256` with HMAC-SHA256 and a `sha256=` prefix.

Implication for design:
- `auth.method=app` should carry `appId`, `installationId`, and a private key secret.
- Controller should mint short-lived tokens and cache them by installation ID.

### GitLab
- Project and personal access tokens have explicit repository scopes like `read_repository` and `write_repository`.
- Webhook secret tokens are delivered via the `X-Gitlab-Token` header.

Implication for design:
- `auth.method=token` should support GitLab access tokens and enforce `write_repository` for PR/merge creation.

### Bitbucket Cloud
- App passwords are being replaced by API tokens. API tokens have scopes and can be limited to a workspace.

Implication for design:
- `auth.method=token` should treat Bitbucket credentials as API tokens with explicit scope requirements.

### Gitea
- Gitea accepts API tokens via the `Authorization: token` header (or query parameters).

Implication for design:
- `auth.method=token` can be used directly; `apiBaseUrl` and `webBaseUrl` must be configurable for self-hosted installs.

## Repository URL Resolution
Add explicit settings to avoid hard-coded GitHub assumptions:
- `cloneBaseUrl` + `repository` => `https://{cloneBaseUrl}/{owner}/{repo}.git`
- `cloneProtocol`: `https | ssh` (optional) with `sshHost` and `sshUser` if needed
- `webBaseUrl` + `repository` => repository browser URLs for UI links

## Observability and Provenance
- Store resolved `vcsProvider`, `repository`, and `head/base` in AgentRun status.
- Record whether VCS writes were skipped or failed, and surface this in `status.conditions`.

## Examples

### VersionControlProvider (GitHub)
```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: VersionControlProvider
metadata:
  name: github
spec:
  provider: github
  apiBaseUrl: https://api.github.com
  cloneBaseUrl: https://github.com
  webBaseUrl: https://github.com
  auth:
    method: token
    token:
      secretRef:
        name: codex-github-token
        key: token
  repositoryPolicy:
    allow:
      - proompteng/lab
  capabilities:
    read: true
    write: true
    pullRequests: true
  defaults:
    baseBranch: main
    branchTemplate: codex/{{issueNumber}}
    commitAuthorName: codex
    commitAuthorEmail: codex@proompt.com
    pullRequest:
      enabled: true
      draft: false
      titleTemplate: "Codex: {{repository}}"
      bodyTemplate: "Closes #{{issueNumber}}"
```

### Agent referencing VCS provider
```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: Agent
metadata:
  name: codex-agent
spec:
  providerRef:
    name: codex-runner
  vcsRef:
    name: github
```

### AgentRun overriding VCS policy
```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: codex-run-sample
spec:
  agentRef:
    name: codex-agent
  implementationSpecRef:
    name: codex-impl-sample
  runtime:
    type: workflow
  vcsPolicy:
    required: false
    mode: read-only
```

## Chart Changes
- Add new CRD: `charts/agents/crds/agents.proompteng.ai_versioncontrolproviders.yaml`.
- Add example manifest: `charts/agents/examples/versioncontrolprovider-github.yaml`.
- Document the VCS provider in `charts/agents/README.md` or `docs/agents/`.
- Do not install any provider by default; keep the chart provider-agnostic.

## UI and agentctl (follow-up)
- Control plane should surface VCS providers and allow selection per run.
- agentctl should accept `--vcs` and `--vcs-required` flags, and emit `vcsRef`/`vcsPolicy` in manifests.

## Migration Plan
1. Introduce the CRD and no-op wiring (no behavior change if no provider is set).
2. Update controller to resolve providers and inject configuration into run specs.
3. Update runtime scripts to read standardized VCS env/config.
4. Update UI/agentctl to expose selection and policy.
5. Deprecate implicit GitHub-only defaults and document the new flow.

## References
- GitHub App installation token flow and expiration: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- GitHub App token creation endpoint and scoping: https://docs.github.com/en/enterprise-cloud%40latest/rest/apps/apps
- GitHub webhook signature header (HMAC-SHA256): https://docs.github.com/en/developers/webhooks-and-events/webhooks/securing-your-webhooks
- GitLab personal access token scopes: https://docs.gitlab.com/user/profile/personal_access_tokens/
- GitLab project access token scopes: https://docs.gitlab.com/user/project/settings/project_access_tokens/
- GitLab webhook secret header: https://docs.gitlab.com/ee/user/project/integrations/webhooks.html
- Bitbucket API tokens (replacement for app passwords): https://support.atlassian.com/bitbucket-cloud/docs/app-passwords/
- Bitbucket API token overview: https://support.atlassian.com/bitbucket-cloud/docs/app-passwords/
- Gitea API authentication methods: https://docs.gitea.com/1.20/development/api-usage
