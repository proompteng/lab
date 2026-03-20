# Huly Swarm Recovery and Account Rebuild Runbook

## Overview

Use this runbook when Huly appears alive at the ingress or pod level but account-backed flows are broken, or when the swarm Huly identities need a full rebuild.

This runbook covers:

- verifying real Huly health beyond Argo and pod status
- repairing the account migration path
- rebuilding swarm users through the live UI
- extracting fresh workspace tokens and actor IDs
- resealing the swarm Huly secrets
- validating tracker, chat, and docs access before resuming automation

## Preconditions

- `kubectl`, `argocd`, `kubeseal`, `bun`, and Playwright MCP/browser access are available.
- Cluster access to namespaces `huly` and `agents` is working.
- The Sealed Secrets controller is reachable as:
  - name: `sealed-secrets`
  - namespace: `sealed-secrets`

## Phase 1: Verify Real Huly Health

Do not trust `Running` pods or `argocd app get huly` by themselves.

1. Check live workload status.
   - `kubectl get pods -n huly`
   - `argocd app get huly -o json | jq '{sync: .status.sync.status, health: .status.health.status, operation: .status.operationState.phase, message: .status.operationState.message}'`
2. Inspect account, transactor, and workspace logs.
   - `kubectl -n huly logs deployment/account --tail=200`
   - `kubectl -n huly logs deployment/transactor --tail=200`
   - `kubectl -n huly logs deployment/workspace --tail=200`
3. Verify the account migration state and table counts.
   - `kubectl -n huly exec cockroach-0 -- sh -lc "cockroach sql --certs-dir=/cockroach/cockroach-certs --host=cockroach-public --execute=\"SELECT identifier, applied_at IS NOT NULL AS applied FROM defaultdb.global_account._account_applied_migrations WHERE identifier = 'account_db_v2_social_id_pk_change'; SELECT 'account' AS table_name, count(*) FROM defaultdb.global_account.account UNION ALL SELECT 'person', count(*) FROM defaultdb.global_account.person UNION ALL SELECT 'workspace', count(*) FROM defaultdb.global_account.workspace UNION ALL SELECT 'social_id', count(*) FROM defaultdb.global_account.social_id;\""`
4. Verify transactor can still reach the account service through the real handshake path.
   - `kubectl -n huly exec deploy/transactor -- node -e "const body=JSON.stringify({method:'workerHandshake',params:{region:'DEFAULT',version:'0.7.375',operation:'all',wsId:'healthcheck'}}); const res=await fetch('http://account/',{method:'POST',headers:{'Content-Type':'application/json'},body}); console.log(res.status); console.log(await res.text())"`
5. Verify browser login actually reaches a workspace, not just the shell.
   - use Playwright/browser automation against `https://huly.proompteng.ai/login/login`

Healthy state means:

- no repeating migration loop in `account`
- `account_db_v2_social_id_pk_change` marked applied
- account tables are writable and non-empty after user creation
- transactor/account handshake returns quickly
- browser login reaches `/workbench/<workspace>`

## Phase 2: Repair the Account Migration Path

The live repair path for the March 19 incident was:

1. Keep these GitOps resources current:
   - [argocd/applications/huly/cockroach/cockroach-account-migration-repair-job.yaml](../../argocd/applications/huly/cockroach/cockroach-account-migration-repair-job.yaml)
   - [argocd/applications/huly/config/healthcheck-scripts-configmap.yaml](../../argocd/applications/huly/config/healthcheck-scripts-configmap.yaml)
2. If the migration is already stuck and GitOps has not yet converged, repair Cockroach with the same DDL the job uses:
   - `ALTER TABLE defaultdb.global_account.otp DROP CONSTRAINT IF EXISTS otp_social_id_fk;`
   - `ALTER TABLE defaultdb.global_account.social_id ALTER PRIMARY KEY USING COLUMNS (_id);`
3. Mark the stuck migration row applied only after the schema repair has succeeded.
4. Restart `account`, `transactor`, and `workspace`.
5. Sync Argo again and require `argocd/huly` to return to `Synced Healthy`.

## Phase 3: Recreate Swarm Users Through the UI

Do not recreate swarm users with direct database writes.

The controlled flow is:

1. Create the owner account through `https://huly.proompteng.ai/login/signup`.
2. Create or select the workspace slug.
3. Generate invite links from the owner account for the remaining swarm users.
4. Use Playwright or browser automation to complete invite-based signup for the remaining users.
5. Use real first and last names and keep the existing identity mapping stable when possible.

The current swarm roster is:

- Victor Chen
- Elise Novak
- Marco Silva
- Gideon Park
- Naomi Ibarra
- Julian Hart

## Phase 4: Extract Tokens and Actor IDs

Each rebuilt user needs two pieces of auth state:

- workspace token
- expected actor ID (`primarySocialId`)

The account RPC payloads discovered from the live browser flow are:

1. Login:

```json
{
  "method": "login",
  "params": {
    "email": "user@example.com",
    "password": "..."
  }
}
```

2. Select workspace:

```json
{
  "method": "selectWorkspace",
  "params": {
    "workspaceUrl": "proompteng",
    "kind": "external",
    "externalRegions": []
  }
}
```

3. Resolve expected actor ID:
   - call `GET /api/v1/account/<workspace-id>` on `transactor` with the workspace token
   - use `primarySocialId`

The helper script expects a JSON array shaped like:

```json
[
  {
    "humanName": "Victor Chen",
    "email": "victor.chen.swarm@proompteng.ai",
    "team": "jangar",
    "role": "architect",
    "workspaceToken": "...",
    "actorId": "1159636472324784130"
  }
]
```

## Phase 5: Validate Access Before Rotating Secrets

Validate every recreated user in both layers.

### Browser validation

For each user:

1. log in through `/login/login`
2. select workspace `proompteng`
3. open:
   - tracker: `/workbench/proompteng/tracker/tracker%3Aproject%3ADefaultProject/issues`
   - chat: `/workbench/proompteng/chunter/chunter%3Aspace%3AGeneral%7Cchunter%3Aclass%3AChannel?message`
   - docs: `/workbench/proompteng/document`
4. fail if any page shows permission-denied, missing-workspace, or access-denied content

### API validation

For each user:

1. `account-info`
2. `list-channel-messages --channel general`
3. `verify-chat-access --channel general --message "..."`

Use strict actor validation:

```bash
HULY_API_BASE_URL=http://transactor.huly.svc.cluster.local \
HULY_WORKSPACE_ID=<workspace-id> \
HULY_API_TOKEN=<workspace-token> \
python3 skills/huly-api/scripts/huly-api.py \
  --operation account-info \
  --expected-actor-id <actor-id> \
  --require-expected-actor-id
```

## Phase 6: Reseal the Swarm Secrets

Use the helper script:

```bash
bun scripts/generate-huly-swarm-sealed-secrets.ts --input /tmp/huly-swarm-auth.json
```

That updates:

- [argocd/applications/agents/huly-api-jangar-sealedsecret.yaml](../../argocd/applications/agents/huly-api-jangar-sealedsecret.yaml)
- [argocd/applications/agents/huly-api-torghut-sealedsecret.yaml](../../argocd/applications/agents/huly-api-torghut-sealedsecret.yaml)

The helper preserves the shared Huly config keys:

- `HULY_API_BASE_URL`
- `HULY_CHANNEL`
- `HULY_PROJECT`
- `HULY_TEAMSPACE`
- `HULY_WORKSPACE`

and rotates only the per-worker token and expected-actor values.

## Phase 7: Roll Out and Verify

1. Commit the sealed secret updates and any prompt/doc changes.
2. Merge the PR.
3. Sync the `agents` Argo app.
   - `argocd app sync agents`
4. Verify the live secrets exist:
   - `kubectl get secret huly-api-jangar -n agents`
   - `kubectl get secret huly-api-torghut -n agents`
5. Re-run at least one helper validation against the live secret-backed values if needed.
6. Resume swarm Huly-dependent automation only after the browser and API checks pass.

## Failure Modes

- If login works but `selectWorkspace` does not, the account service is not truly healthy yet.
- If tracker/chat/docs differ across users, stop and fix workspace membership before rotating secrets.
- If `account-info` returns an actor mismatch, do not patch the expected actor ID blindly; re-extract the workspace token and verify the account actually belongs to the intended human.
- If `kubeseal` cannot reach the controller, stop and fix Sealed Secrets connectivity before writing manifests.

## References

- [docs/incidents/2026-03-19-huly-account-migration-recovery-and-swarm-rebuild.md](../incidents/2026-03-19-huly-account-migration-recovery-and-swarm-rebuild.md)
- [skills/huly-api/SKILL.md](../../skills/huly-api/SKILL.md)
- [scripts/generate-huly-swarm-sealed-secrets.ts](../../scripts/generate-huly-swarm-sealed-secrets.ts)
