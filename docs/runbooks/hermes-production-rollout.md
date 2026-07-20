# Hermes production rollout and OpenClaw cutover

This runbook deploys Hermes as Tuslagch's production runtime, migrates non-secret OpenClaw user data, transfers the Discord
channel without dual writers, and retains a tested rollback path. All `kubectl` commands use an explicit namespace.

## Invariants

- Never run OpenClaw and Hermes with the same Discord token at the same time.
- Never pass `--migrate-secrets` to the OpenClaw migration.
- Never store or print the API key or Discord token in Git, shell history, logs, Job specs, or evidence artifacts.
- Never run `hermes claw cleanup`, delete the OpenClaw VM/PVC, or delete Hermes PVCs during the 14-day rollback window.
- A `Synced/Healthy` Argo application is not sufficient proof. Record authenticated inference, persistence, egress, backup,
  migration, and Discord lifecycle evidence.
- Roll out and cut over only from merged `main`; do not deploy manifests from an unmerged worktree.

## Release evidence

Before each rollout, verify and record:

```bash
git rev-parse origin/main
crane digest docker.io/nousresearch/hermes-agent:v2026.7.7.2
crane digest registry.ide-newton.ts.net/lab/hermes-agent:v2026.7.7.2-amd64
kubectl -n argocd get application hermes -o jsonpath='{.status.sync.revision}{"\n"}'
```

The expected upstream index digest is `sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973`.
The expected mirrored amd64 manifest digest is
`sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a`.

## Phase 0: preflight and secret

1. Confirm OpenClaw and Flamingo are healthy, and record the OpenClaw VM/PVC identities:

   ```bash
   kubectl -n openclaw get virtualmachine,virtualmachineinstance,pvc -o wide
   kubectl -n flamingo get deployment,service,pod -o wide
   kubectl -n flamingo rollout status deployment/flamingo --timeout=10m
   ```

2. Create a minimum 32-byte API key in the `infra` 1Password vault. Do this from a private shell with 1Password unlocked;
   do not echo the generated value:

   ```bash
   hermes_api_key=$(openssl rand -hex 32)
   op item create --vault infra --category login --title hermes-runtime \
     "API_SERVER_KEY[password]=$hermes_api_key" >/dev/null
   unset hermes_api_key
   ```

3. Wait for the ApplicationSet to create the manual Hermes app, sync it, and verify the secret bridge without reading the
   value:

   ```bash
   argocd app get hermes --refresh
   argocd app sync hermes --prune=false
   kubectl -n hermes wait externalsecret/hermes-api-auth --for=condition=Ready --timeout=5m
   kubectl -n hermes get secret hermes-api-auth -o jsonpath='{.data.API_SERVER_KEY}' | base64 -d | wc -c
   ```

   The reported key length must be at least 32. Do not include the value in rollout evidence.

## Phase 1: API-only canary

1. Verify rollout, immutable images, security context, and PVCs. Then create a one-time Job from the daily backup CronJob so
   rollout evidence does not depend on the next schedule:

   ```bash
   kubectl -n hermes rollout status deployment/hermes-egress-proxy --timeout=5m
   kubectl -n hermes rollout status statefulset/hermes --timeout=15m
   kubectl -n hermes get pod hermes-0 -o jsonpath='{range .spec.containers[*]}{.name}{"="}{.image}{"\n"}{end}'
   kubectl -n hermes get pod hermes-0 -o jsonpath='{.spec.securityContext.runAsUser}{" "}{.spec.automountServiceAccountToken}{"\n"}'
   kubectl -n hermes get pvc data-hermes-0 backups-hermes-0
   initial_backup_job="hermes-backup-initial-$(date -u +%Y%m%d%H%M%S)"
   kubectl -n hermes create job --from=cronjob/hermes-backup "$initial_backup_job"
   kubectl -n hermes wait "job/$initial_backup_job" --for=condition=Complete --timeout=15m
   kubectl -n hermes logs "job/$initial_backup_job" -c backup
   kubectl -n hermes exec hermes-0 -c hermes -- test -s /opt/backups/last-success
   kubectl -n hermes exec hermes-0 -c hermes -- sh -c \
     'cd /opt/backups; archive=$(find . -maxdepth 1 -name "hermes-backup-*.zip" -type f | sort -r | head -1); test -n "$archive" && sha256sum -c "$archive.sha256"'
   ```

   The Job must complete and its log and checksum verification must succeed. A standalone Job does not update the CronJob's
   status; `HermesBackupStale` grants a new CronJob 26 hours for its first scheduled success, then monitors its last
   successful completion. A missing CronJob still alerts, and backup failure never changes the gateway Pod's readiness.

2. Port-forward the cluster-local API and keep the key out of command output:

   ```bash
   kubectl -n hermes port-forward service/hermes 18642:8642
   ```

   In a second private shell:

   ```bash
   hermes_api_key=$(kubectl -n hermes get secret hermes-api-auth -o jsonpath='{.data.API_SERVER_KEY}' | base64 -d)
   test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18642/health/detailed)" = 401
   curl -fsS -H "Authorization: Bearer $hermes_api_key" http://127.0.0.1:18642/health/detailed | jq -e \
     '.status == "ok" and .gateway_state == "running"'
   curl -fsS -H "Authorization: Bearer $hermes_api_key" http://127.0.0.1:18642/v1/models | jq -e \
     '.data | any(.id == "tuslagch")'
   curl -fsS -H "Authorization: Bearer $hermes_api_key" -H 'Content-Type: application/json' \
     -d '{"model":"tuslagch","messages":[{"role":"user","content":"Reply with exactly HERMES_CANARY_OK"}]}' \
     http://127.0.0.1:18642/v1/chat/completions | jq -e \
     '.choices[0].message.content | contains("HERMES_CANARY_OK")'
   unset hermes_api_key
   ```

3. Prove state survives a restart. Create a harmless canary file, restart the pod, and read it back:

   ```bash
   kubectl -n hermes exec hermes-0 -c hermes -- sh -c 'date -u > /opt/data/workspace/tuslagch/.rollout-canary'
   kubectl -n hermes delete pod hermes-0
   kubectl -n hermes rollout status statefulset/hermes --timeout=15m
   kubectl -n hermes exec hermes-0 -c hermes -- test -s /opt/data/workspace/tuslagch/.rollout-canary
   ```

4. Prove network containment from the gateway and domain filtering through Squid:

   ```bash
   kubectl -n hermes exec hermes-0 -c hermes -- /opt/hermes/.venv/bin/python -c \
     'import urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open("https://example.com", timeout=5)'
   kubectl -n hermes exec hermes-0 -c hermes -- /opt/hermes/.venv/bin/python -c \
     'import urllib.request; urllib.request.urlopen("https://discord.com/robots.txt", timeout=10).read(1)'
   kubectl -n hermes exec hermes-0 -c hermes -- /bin/sh -c \
     '! /opt/hermes/.venv/bin/python -c '\''import urllib.request; urllib.request.urlopen("https://example.com", timeout=5)'\'''
   ```

   The direct public request must fail. Discord through Squid must connect, and the non-allowlisted domain must fail.

## Phase 2: non-secret user-data migration

1. Build a sanitized source archive from the OpenClaw workspace. Only the listed identity and memory paths are exported;
   `.openclaw/openclaw.json`, credentials, tokens, sessions, and logs never enter the archive:

   ```bash
   hermes_stage_dir=$(mktemp -d)
   mkdir -p "$hermes_stage_dir/openclaw/workspace"
   virtctl ssh -n openclaw --username ubuntu --identity-file /Users/gregkonush/.ssh/id_ed25519 \
     --local-ssh-opts='-o IdentityAgent=none' --local-ssh-opts='-o IdentitiesOnly=yes' \
     --command='tar --ignore-failed-read -C /home/ubuntu/github.com/lab/services/tuslagch -czf - AGENTS.md SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md MEMORY.md memory skills' \
     vm/openclaw | tar -xzf - -C "$hermes_stage_dir/openclaw/workspace"
   find "$hermes_stage_dir/openclaw" -type f -print
   ```

   Review the file-name-only inventory. Stop if it contains config, credential, token, session, or log files.

2. Stage the sanitized directory on the Hermes data PVC, then stop the gateway so the migration has exclusive RBD access:

   ```bash
   kubectl -n hermes exec hermes-0 -c hermes -- mkdir -p /opt/data/migration/openclaw
   kubectl -n hermes cp "$hermes_stage_dir/openclaw/." hermes-0:/opt/data/migration/openclaw -c hermes
   rm -rf -- "$hermes_stage_dir"
   unset hermes_stage_dir
   kubectl -n hermes scale statefulset/hermes --replicas=0
   kubectl -n hermes wait pod/hermes-0 --for=delete --timeout=10m
   ```

3. Run the merged dry-run Job and review its complete log. It must contain no secret migration and no unresolved conflict:

   ```bash
   dry_run_job=$(kubectl -n hermes create -f argocd/applications/hermes/operations/migration-dry-run-job.yaml -o name)
   kubectl -n hermes wait "$dry_run_job" --for=condition=Complete --timeout=10m
   kubectl -n hermes logs "$dry_run_job"
   ```

4. If the preview is correct, run the apply Job. Preserve its Job name, log, report summary, and generated restore-point
   archive as migration evidence:

   ```bash
   migration_job=$(kubectl -n hermes create -f argocd/applications/hermes/operations/migration-apply-job.yaml -o name)
   kubectl -n hermes wait "$migration_job" --for=condition=Complete --timeout=10m
   kubectl -n hermes logs "$migration_job"
   ```

5. Restore desired replicas through Argo and repeat authenticated inference, persistence, and backup checks:

   ```bash
   argocd app sync hermes --prune=false
   kubectl -n hermes rollout status statefulset/hermes --timeout=15m
   ```

## Phase 3: Discord cutover

Discord activation requires a second PR. That PR must:

- add an ExternalSecret mapping `hermes-runtime/DISCORD_BOT_TOKEN` and `hermes-runtime/DISCORD_ALLOWED_USERS`;
- inject both secret keys into the gateway container;
- set `platforms.discord.enabled: true`;
- set OpenClaw `spec.running: false` and remove the OpenClaw `cluster-admin` binding;
- retain the OpenClaw VM, root-disk PVC, cloud-init Secret, and scoped read-only rollback resources;
- retain manual Argo automation so the token transfer and sync are ordered by the operator.

Cutover sequence:

1. Record the current OpenClaw Discord allowlist count, stop OpenClaw through the merged GitOps change, and verify its VMI is
   gone before provisioning Hermes. Do not log the token.
2. In a private shell, transfer the existing bot token and numeric allowlist directly into the `hermes-runtime` 1Password
   item, then unset local variables.
3. Wait for the ExternalSecret to be Ready, sync Hermes, and prove only one Discord bot session is active.
4. From the allowlisted account, send a unique canary message and capture the inbound message ID, Hermes session ID, response
   message ID, and timestamp. Verify a non-allowlisted account is rejected or ignored.
5. Restart `hermes-0`, send a second canary, and verify session/memory continuity plus a current successful backup.

Do not declare cutover complete from pod readiness alone.

## Rollback

Hard rollback triggers are any unauthorized Discord response, non-allowlisted egress, failed authenticated inference for 15
minutes, loss/corruption of migrated state, backup verification failure, or repeated gateway restarts.

### Before Discord cutover

```bash
argocd app sync hermes --revision '<last-known-good-main-sha>' --prune=false
kubectl -n hermes rollout status statefulset/hermes --timeout=15m
```

The OpenClaw runtime remains unchanged and authoritative.

### After Discord cutover

1. Disable Discord in Hermes and stop its pod through a reviewed GitOps rollback.
2. Verify the Hermes VMI-equivalent workload is gone before restarting OpenClaw; never allow both runtimes to connect.
3. Revert OpenClaw `spec.running` and scoped RBAC through GitOps. Restore the token to OpenClaw only after Hermes is stopped.
4. Verify OpenClaw's Discord lifecycle and retain Hermes PVCs/backups for investigation.

### Restore Hermes data from a verified backup

Scale Hermes to zero, select a known-good archive, verify its SHA-256 sidecar, and copy it to the fixed restore path. Replace
the archive name below with the reviewed recovery point; never select it only by recency:

```bash
kubectl -n hermes scale statefulset/hermes --replicas=0
kubectl -n hermes wait pod/hermes-0 --for=delete --timeout=10m
kubectl -n hermes create -f argocd/applications/hermes/operations/restore-stage-pod.yaml
kubectl -n hermes wait pod/hermes-restore-stage --for=condition=Ready --timeout=5m
kubectl -n hermes exec hermes-restore-stage -c stage -- ls -1 /opt/backups/hermes-backup-*.zip
restore_archive=hermes-backup-YYYYMMDDTHHMMSSZ.zip
kubectl -n hermes exec hermes-restore-stage -c stage -- sh -c \
  "cd /opt/backups && sha256sum -c '$restore_archive.sha256' && cp '$restore_archive' restore.zip"
kubectl -n hermes delete pod hermes-restore-stage --wait=true
restore_job=$(kubectl -n hermes create -f argocd/applications/hermes/operations/restore-job.yaml -o name)
kubectl -n hermes wait "$restore_job" --for=condition=Complete --timeout=15m
kubectl -n hermes logs "$restore_job"
argocd app sync hermes --prune=false
kubectl -n hermes rollout status statefulset/hermes --timeout=15m
```

Run all Phase 1 checks again after restore. Never overwrite or delete the source archive during the restore.

## Completion evidence

The rollout record is complete only when it includes:

- merged PRs and exact `main` revisions for API canary and Discord cutover;
- image digests and upstream release commit;
- Argo `Synced/Healthy` readback at those revisions;
- ExternalSecret Ready conditions and secret field lengths/counts without values;
- pod UID, read-only rootfs, no-token, NetworkPolicy, PVC, and verified backup evidence;
- authenticated API rejection/success, Flamingo model response, and persistence after restart;
- migration dry-run/apply Job identities and report counts;
- single-writer Discord message lifecycle IDs and non-allowlisted-user rejection;
- retained OpenClaw VM/PVC identities, rollback revision, and rollback-window end timestamp.
