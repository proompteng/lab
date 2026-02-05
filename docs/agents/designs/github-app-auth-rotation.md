# GitHub App Auth and Token Rotation

Status: Current (2026-02-05)

## Purpose
Support GitHub App installation tokens for VCS operations, including safe rotation and caching.

## Current State
- `VersionControlProvider.spec.auth.app` supports `appId`, `installationId`, `privateKeySecretRef`, and
  `tokenTtlSeconds` (`charts/agents/templates/versioncontrolprovider.yaml`).
- `services/jangar/src/server/agents-controller.ts`:
  - Mints a JWT and requests installation tokens via GitHub API.
  - Caches tokens in memory keyed by `apiBaseUrl|installationId`.
  - Refreshes tokens before expiry using a refresh window (10% of TTL, min 30s, max 5 min).
  - Injects `VCS_TOKEN`, `GITHUB_TOKEN`, and `GH_TOKEN` into the agent runtime env.
- Cluster: no `VersionControlProvider` resources are present today, so GitHub App auth is not currently in use.

## Design
- Use GitHub App installation tokens for all write-enabled VCS operations.
- Cache tokens per controller process and refresh before expiry to avoid failed PR operations.
- Reject missing or invalid auth configuration early and surface status conditions on the
  `VersionControlProvider` resource.

## Configuration
`VersionControlProvider.spec.auth.app` fields:
- `appId`: GitHub App ID (string or number).
- `installationId`: GitHub App installation ID.
- `privateKeySecretRef.name`: Secret containing the PEM private key.
- `privateKeySecretRef.key`: Key in the Secret (default `privateKey`).
- `tokenTtlSeconds`: Optional TTL override if GitHub does not return `expires_at`.

## Runtime Behavior
- Token minting uses RSA SHA256 signing and the GitHub App access token endpoint.
- Token caching is in-memory only; each controller replica maintains its own cache.
- If a token cannot be minted, VCS resolution fails and the AgentRun is marked as invalid.

## Operational Notes
- For HA, each replica will mint its own tokens; the GitHub App installation rate limits should be sized
  accordingly.
- Use SecretBindings to allow the GitHub App private key Secret for the relevant Agents.

## Validation
- Create a `VersionControlProvider` with `auth.app` and confirm the status `Warning` is empty and `Ready=True`.
- Run a workflow that creates a PR and confirm `GH_TOKEN` is set in the runtime env.
