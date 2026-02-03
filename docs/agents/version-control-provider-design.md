# Version Control Provider Design

Status: Implemented (2026-02-03)

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

## Current State (post-implementation)
- ImplementationSource continues to support `github` and `linear` for issue intake.
- A new `VersionControlProvider` CRD models repo access, auth, and defaults.
- `vcsRef` can be set on Agent, ImplementationSpec, or AgentRun; `vcsPolicy` lives on AgentRun.
- The controller resolves the provider, validates policy/capabilities, and injects provider-agnostic VCS env vars (while still exporting GitHub-compatible tokens when appropriate).
- SecretBinding remains the enforcement point for provider secrets, so VCS credentials must be allowlisted before a run can use them.

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
- `mode` defaults to `read-write` when omitted.
- If `mode=none`, the controller skips VCS entirely (useful when a run should not require any repo access).
- If `required=true` and the provider is missing, denied by policy, or cannot satisfy the requested mode, the run fails early.
- If `required=false`, the run proceeds and VCS operations are skipped when unavailable; artifacts are still produced locally.

## Controller Behavior
The controller should:
1. Resolve the VCS provider using the reference order above.
2. Validate provider availability and policy (allowlist, capabilities).
3. Populate runtime env or config with VCS settings (base URLs, auth paths, branch defaults).
4. Enforce allowlists/blocked secrets, and require SecretBinding for provider secrets.
5. Respect `vcsPolicy.mode` and `vcsPolicy.required`, marking runs as skipped or failed when VCS cannot be satisfied.

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
  - `VCS_PROVIDER` / `VCS_PROVIDER_NAME`
  - `VCS_API_BASE_URL`
  - `VCS_CLONE_BASE_URL`
  - `VCS_WEB_BASE_URL`
  - `VCS_REPOSITORY`
  - `VCS_BASE_BRANCH`
  - `VCS_HEAD_BRANCH`
  - `VCS_TOKEN`
  - `VCS_SSH_KEY_PATH` (if SSH)
  - `VCS_SSH_KNOWN_HOSTS_PATH`
  - `VCS_USERNAME`
  - `VCS_MODE`, `VCS_WRITE_ENABLED`, `VCS_PULL_REQUESTS_ENABLED`
  - `VCS_PR_TITLE_TEMPLATE`, `VCS_PR_BODY_TEMPLATE`, `VCS_PR_DRAFT`
  - `VCS_COMMIT_AUTHOR_NAME`, `VCS_COMMIT_AUTHOR_EMAIL`

This keeps GitHub-specific tooling working while allowing multi-provider behavior.

## SecretBinding Integration
When a provider uses a secret, that secret must be allowed by SecretBinding for the Agent. The controller should:
- Add the provider secret to the run’s required secrets if not already present.
- Enforce existing SecretBinding policy checks.
- Allow `vcsPolicy.mode=none` to bypass SecretBinding requirements for VCS.
- Fail only if `vcsPolicy.required=true` and the provider cannot be satisfied.

## Provider-Specific Guidance (from research)

### GitHub
- GitHub Apps mint installation access tokens via the REST API, and those tokens expire after 1 hour.
- Installation access tokens are generated with a GitHub App JWT and used in the `Authorization` header.
  - Reference: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- Personal access tokens for HTTPS Git operations require a non-empty username, but the username is not used to authenticate; the token is used as the password.
  - Reference: https://docs.github.com/en/enterprise-server%403.18/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens

Implication for design:
- `auth.method=app` carries `appId`, `installationId`, and a private key secret.
- Controller mints short-lived tokens and caches them by installation ID.

### GitLab
- Project access tokens include `read_repository` and `write_repository` scopes, where `write_repository` grants both read and write for git operations.
  - Reference: https://docs.gitlab.com/user/project/settings/project_access_tokens.html
- When cloning over HTTPS with a personal access token, the username can be any string as long as it is non-empty.
  - Reference: https://docs.gitlab.com/user/profile/personal_access_tokens/

Implication for design:
- `auth.method=token` supports GitLab tokens and requires `write_repository` for push/merge flows.

### Bitbucket Cloud
- Access tokens (repository/project/OAuth) can be used for HTTPS git operations with the literal username `x-token-auth`.
- Bitbucket OAuth access tokens are also accepted via `Authorization: Bearer` for API requests.
  - Reference: https://support.atlassian.com/bitbucket-cloud/docs/using-access-tokens/
  - Reference: https://support.atlassian.com/bitbucket-cloud/docs/using-project-access-tokens/
  - Reference: https://developer.atlassian.com/cloud/bitbucket/oauth-2/

Implication for design:
- `auth.method=token` should treat Bitbucket credentials as access tokens and use `x-token-auth` for HTTPS clones.

### Gitea
- Gitea accepts API tokens via `Authorization: token <token>` (and via `token=`/`access_token=` query parameters).
  - Reference: https://docs.gitea.com/1.20/development/api-usage

Implication for design:
- `auth.method=token` can be used directly; `apiBaseUrl` and `webBaseUrl` must be configurable for self-hosted installs.
- For HTTPS Git auth, set `spec.auth.username` if the provider expects a specific account name.

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
- GitHub personal access tokens (HTTPS Git auth): https://docs.github.com/en/enterprise-server%403.18/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- GitLab personal access tokens (HTTPS Git auth): https://docs.gitlab.com/user/profile/personal_access_tokens/
- GitLab project access token scopes: https://docs.gitlab.com/user/project/settings/project_access_tokens/
- Bitbucket access tokens (HTTPS clone username): https://support.atlassian.com/bitbucket-cloud/docs/using-access-tokens/
- Bitbucket project access tokens: https://support.atlassian.com/bitbucket-cloud/docs/using-project-access-tokens/
- Bitbucket OAuth 2.0 tokens: https://developer.atlassian.com/cloud/bitbucket/oauth-2/
- Gitea API authentication methods: https://docs.gitea.com/1.20/development/api-usage
