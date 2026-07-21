# Hermes production rollout and OpenClaw cutover

This runbook deploys Hermes as Tuslagch's production runtime, migrates non-secret OpenClaw user data, transfers the Discord
channel without dual writers, and retains a tested rollback path. All `kubectl` commands use an explicit namespace.

## Invariants

- Never run OpenClaw and Hermes with the same Discord token at the same time.
- Never pass `--migrate-secrets` to the OpenClaw migration.
- Never store or print the API key or Discord token in Git, shell history, logs, Job specs, or evidence artifacts.
- Never run `hermes claw cleanup`, delete the OpenClaw VM/PVC, or delete Hermes PVCs during the 14-day rollback window.
- Never start migration or restore until the backup CronJob is suspended and every active backup Job has finished.
- Never create a migration or restore Job until every earlier Hermes maintenance Job is terminal.
- Never enable Hermes Discord until a final audited migration is applied after the OpenClaw gateway is inactive.
- Never sync Hermes until the disposable NetworkPolicy enforcement probe passes on the live cluster.
- Every API key rotation must restart `hermes-0` and prove the old key is rejected and the new key is accepted.
- A `Synced/Healthy` Argo application is not sufficient proof. Record authenticated inference, persistence, egress, backup,
  migration, and Discord lifecycle evidence.
- Roll out and cut over only from merged `main`; do not deploy manifests from an unmerged worktree.

## Release evidence

Before each rollout, verify and record:

```bash
set -euo pipefail
git fetch --quiet origin main
main_revision=$(git rev-parse origin/main)
test "$(git rev-parse HEAD)" = "$main_revision"
upstream_digest=$(crane digest docker.io/nousresearch/hermes-agent:v2026.7.7.2)
mirror_digest=$(crane digest registry.ide-newton.ts.net/lab/hermes-agent:v2026.7.7.2-amd64)
test "$upstream_digest" = sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973
test "$mirror_digest" = sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a
argocd app get hermes --refresh >/dev/null
hermes_revision=$(kubectl -n argocd get application hermes -o jsonpath='{.status.sync.revision}')
test "$hermes_revision" = "$main_revision"
printf 'main=%s upstream=%s mirror=%s argo=%s\n' \
  "$main_revision" "$upstream_digest" "$mirror_digest" "$hermes_revision"
unset main_revision upstream_digest mirror_digest hermes_revision
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

2. Empirically prove the live CNI enforces `networking.k8s.io/v1` policies. The probe creates an isolated disposable
   namespace, schedules its bounded client and server on different nodes, first proves Pod-to-Pod connectivity, applies a
   client egress deny, proves that same request fails while both endpoints remain healthy, removes the policy, proves
   connectivity returns, and then deletes the namespace. A rendered or accepted NetworkPolicy object is not enforcement
   evidence:

   ```bash
   bash scripts/hermes/verify-network-policy-enforcement.sh
   ```

   `NetworkPolicy is not enforced` is a hard rollout blocker. Do not sync Hermes or weaken the containment test; install
   and validate a compatible policy engine first.

3. Ensure the `infra` 1Password vault contains exactly one `hermes-runtime` item with a minimum 32-byte API key. The
   command is safe to rerun: it reuses and validates an existing item, and creates one only when none exists. Do this from
   a private shell with 1Password unlocked; do not echo the generated value:

   ```bash
   set -euo pipefail
   cleanup_api_key() {
     unset hermes_api_key hermes_item_count hermes_item_id api_key_bytes
   }
   abort_api_key() { trap - EXIT HUP INT TERM; cleanup_api_key; exit 130; }
   trap cleanup_api_key EXIT
   trap abort_api_key HUP INT TERM
   hermes_item_count=$(op item list --vault infra --format json | \
     jq -er '[.[] | select(.title == "hermes-runtime")] | length')
   case "$hermes_item_count" in
     0)
       hermes_api_key=$(openssl rand -hex 32)
       op item template get 'Secure Note' | \
         jq --rawfile api_server_key <(printf '%s' "$hermes_api_key") '
           .title = "hermes-runtime"
           | .fields += [{
               id: "API_SERVER_KEY",
               type: "CONCEALED",
               label: "API_SERVER_KEY",
               value: $api_server_key
             }]
         ' | op item create --vault infra - >/dev/null
       ;;
     1) ;;
     *)
       echo 'multiple hermes-runtime items found; reconcile them before continuing' >&2
       exit 1
       ;;
   esac
   hermes_item_id=$(op item list --vault infra --format json | \
     jq -er '[.[] | select(.title == "hermes-runtime") | .id] |
       if length == 1 then .[0] else error("exactly one hermes-runtime item is required") end')
   api_key_bytes=$(op item get --vault infra "$hermes_item_id" --format json | \
     jq -er '[.fields[] | select(.label == "API_SERVER_KEY")] as $fields |
       if ($fields | length) == 1 and $fields[0].type == "CONCEALED" and ($fields[0].value | type) == "string"
       then ($fields[0].value | length)
       else error("exactly one concealed API_SERVER_KEY field is required")
       end')
   test "$api_key_bytes" -ge 32
   cleanup_api_key
   trap - EXIT HUP INT TERM
   ```

4. Wait for the ApplicationSet to create the manual Hermes app, sync it, and verify the secret bridge without reading the
   value:

   ```bash
   set -euo pipefail
   argocd app get hermes --refresh
   argocd app sync hermes --prune=false
   kubectl -n hermes get namespace hermes -o json |
     jq -e '.metadata.labels["observability.proompteng.ai/hermes-rollout-enabled"] == "true"'
   hermes_deployed_revision=$(kubectl -n argocd get application hermes -o json | jq -r '.status.history[-1].revision // empty')
   test "$hermes_deployed_revision" = "$(git rev-parse HEAD)"
   kubectl -n hermes wait externalsecret/hermes-api-auth --for=condition=Ready --timeout=5m
   api_key_bytes=$(kubectl -n hermes get secret hermes-api-auth -o jsonpath='{.data.API_SERVER_KEY}' | base64 -d | wc -c | tr -d '[:space:]')
   test "$api_key_bytes" -ge 32
   printf '%s\n' "$api_key_bytes"
   unset api_key_bytes hermes_deployed_revision
   ```

   The Argo deployment history is the durable alert-enablement source and must contain a successful deployment. It remains
   outside the Hermes namespace and is re-exported after monitoring restarts. The reported key length must be at least 32.
   Do not include the value in rollout evidence.

## Phase 1: API-only canary

1. Verify rollout, immutable images, security context, and PVCs. Then create a one-time Job from the daily backup CronJob so
   rollout evidence does not depend on the next schedule:

   ```bash
   set -euo pipefail
   kubectl -n hermes rollout status deployment/hermes-egress-proxy --timeout=5m
   kubectl -n hermes rollout status statefulset/hermes --timeout=15m
   kubectl -n hermes get pod hermes-0 -o jsonpath='{range .spec.containers[*]}{.name}{"="}{.image}{"\n"}{end}'
   test "$(kubectl -n hermes get pod hermes-0 -o jsonpath='{.spec.securityContext.runAsUser}')" = 10000
   test "$(kubectl -n hermes get pod hermes-0 -o jsonpath='{.spec.automountServiceAccountToken}')" = true
   kubectl -n hermes get pvc data-hermes-0 backups-hermes-0
   maintenance_holder="backup-canary-$(openssl rand -hex 8)"
   release_maintenance_lock() { bash scripts/hermes/maintenance-lock.sh release "$maintenance_holder"; }
   abort_maintenance() { trap - EXIT HUP INT TERM; release_maintenance_lock; exit 130; }
   bash scripts/hermes/maintenance-lock.sh acquire "$maintenance_holder"
   trap release_maintenance_lock EXIT
   trap abort_maintenance HUP INT TERM
   bash scripts/hermes/wait-for-maintenance.sh
   kubectl -n hermes patch cronjob hermes-backup --type=merge -p '{"spec":{"suspend":true}}'
   backup_wait_deadline=$(( $(date +%s) + 3900 ))
   while [ "$(kubectl -n hermes get jobs -l app.kubernetes.io/name=hermes,app.kubernetes.io/component=backup -o json | jq '[.items[] | select(any(.status.conditions[]?; .status == "True" and (.type == "Complete" or .type == "Failed")) | not)] | length')" -gt 0 ]; do
     if [ "$(date +%s)" -ge "$backup_wait_deadline" ]; then
       kubectl -n hermes get jobs -l app.kubernetes.io/name=hermes,app.kubernetes.io/component=backup -o name >&2
       echo 'active Hermes backup did not terminate; backups remain suspended' >&2
       exit 1
     fi
     sleep 10
   done
   unset backup_wait_deadline
   initial_backup_job="hermes-backup-initial-$(date -u +%Y%m%d%H%M%S)"
   kubectl -n hermes create job --from=cronjob/hermes-backup "$initial_backup_job"
   if ! kubectl -n hermes wait "job/$initial_backup_job" --for=condition=Complete --timeout=15m; then
     kubectl -n hermes logs "job/$initial_backup_job" -c backup || true
     kubectl -n hermes delete "job/$initial_backup_job" --wait=true
     kubectl -n hermes patch cronjob hermes-backup --type=merge -p '{"spec":{"suspend":false}}'
     exit 1
   fi
   backup_verified=true
   kubectl -n hermes logs "job/$initial_backup_job" -c backup || backup_verified=false
   kubectl -n hermes exec hermes-0 -c hermes -- test -s /opt/backups/last-success || backup_verified=false
   kubectl -n hermes exec hermes-0 -c hermes -- sh -c '
     set -eu
     cd /opt/backups
     archive_path=$(find . -maxdepth 1 -name "hermes-backup-*.zip" -type f | sort -r | head -1)
     test -n "$archive_path"
     archive_name=$(basename "$archive_path")
     test "$(wc -l < "$archive_name.sha256")" -eq 1
     read -r expected_digest sidecar_archive extra < "$archive_name.sha256"
     test "${#expected_digest}" -eq 64
     case "$expected_digest" in *[!0-9a-f]*) exit 1 ;; esac
     test "$sidecar_archive" = "$archive_name"
     test -z "${extra:-}"
     printf "%s  %s\n" "$expected_digest" "$archive_path" | sha256sum -c -
   ' || backup_verified=false
   kubectl -n hermes patch cronjob hermes-backup --type=merge -p '{"spec":{"suspend":false}}'
   test "$backup_verified" = true
   release_maintenance_lock
   trap - EXIT HUP INT TERM
   unset maintenance_holder
   unset backup_verified
   ```

   The maintenance Lease must remain held. The CronJob must remain suspended until every prior backup and the one-off Job
   have terminated; `concurrencyPolicy` does not prevent a manually created Job from overlapping the schedule. The one-off
   Job must complete and its log, archived SQLite integrity checks, and checksum verification must succeed. The data mount
   is write-capable only because SQLite read-only WAL connections require shared-memory sidecar access; the pinned backup
   process still opens each source database in read-only mode and fails closed on any safe-copy fallback.
   A standalone Job does not update the CronJob's status; `HermesBackupStale` grants a new CronJob 26 hours for its first scheduled success,
   then monitors its last successful completion. A missing CronJob still alerts, and backup failure never changes the
   gateway Pod's readiness.

2. Port-forward the cluster-local API and keep the key out of command output:

   ```bash
   kubectl -n hermes port-forward service/hermes 18642:8642
   ```

   In a second private shell:

   ```bash
   set -euo pipefail
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
   set -euo pipefail
   kubectl -n hermes exec hermes-0 -c hermes -- sh -c 'date -u > /opt/data/workspace/tuslagch/.rollout-canary'
   kubectl -n hermes delete pod hermes-0
   kubectl -n hermes rollout status statefulset/hermes --timeout=15m
   kubectl -n hermes exec hermes-0 -c hermes -- test -s /opt/data/workspace/tuslagch/.rollout-canary
   ```

4. Prove network containment from the gateway and domain filtering through Squid:

   ```bash
   set -euo pipefail
   if kubectl -n hermes exec hermes-0 -c hermes -- /opt/hermes/.venv/bin/python -c \
     'import urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open("https://example.com", timeout=5)'; then
     echo 'direct public egress unexpectedly succeeded' >&2
     exit 1
   fi
   kubectl -n hermes exec hermes-0 -c hermes -- /opt/hermes/.venv/bin/python -c \
     'import urllib.request; request=urllib.request.Request("https://discord.com/api/v10/gateway", headers={"User-Agent":"DiscordBot (https://proompteng.ai, 1.0)"}); response=urllib.request.urlopen(request, timeout=10); assert response.status == 200; response.read(1)'
   kubectl -n hermes exec hermes-0 -c hermes -- \
     git ls-remote --exit-code https://github.com/proompteng/lab.git refs/heads/main
   kubectl -n hermes exec hermes-0 -c hermes -- /bin/sh -c \
     '! /opt/hermes/.venv/bin/python -c '\''import urllib.request; urllib.request.urlopen("https://example.com", timeout=5)'\'''
   ```

   The direct public request must fail. Discord and the credential-free GitHub checkout path must work through Squid, and
   the non-allowlisted domain must fail.

5. Prove the cluster reader and local lab checkout from inside the gateway:

   ```bash
   set -euo pipefail
   kubectl -n hermes exec hermes-0 -c hermes -- sh -c '
     set -eu
     test "$(kubectl auth can-i list pods --all-namespaces)" = yes
     test "$(kubectl auth can-i get pods/log --all-namespaces)" = yes
     test "$(kubectl auth can-i get secrets --all-namespaces)" = no
     test "$(kubectl auth can-i create deployments.apps --all-namespaces)" = no
     kubectl get pods --all-namespaces --request-timeout=10s >/tmp/hermes-cluster-pods
     test -s /tmp/hermes-cluster-pods
     kubectl -n hermes logs statefulset/hermes --tail=1 >/tmp/hermes-gateway-log
     ! kubectl -n hermes get secret hermes-api-auth >/tmp/hermes-secret 2>&1
     ! kubectl -n hermes create configmap hermes-readonly-proof \
       --from-literal=proof=denied --dry-run=server -o name >/tmp/hermes-write 2>&1
     test "$(git -C /opt/data/workspace/tuslagch/lab remote get-url origin)" = \
       https://github.com/proompteng/lab.git
     test "$(cat /opt/data/workspace/tuslagch/.lab-source-revision)" = \
       "$(git -C /opt/data/workspace/tuslagch/lab rev-parse HEAD)"
     git -C /opt/data/workspace/tuslagch/lab cat-file -e HEAD:AGENTS.md
   '
   ```

   The `hermes-cluster-reader` ClusterRole must contain only `get`, `list`, and `watch`. It intentionally excludes core
   Secrets, service-account token subresources, `exec`, `attach`, `proxy`, and `port-forward`. The server-side dry-run is an
   authorization proof: it must be rejected before admission and must not create a ConfigMap.

## API key rotation

External Secrets updates the Kubernetes Secret but cannot change environment variables in an existing container. Every API
key rotation therefore includes a bounded Secret refresh, a gateway Pod restart, and old-key/new-key authentication proof.
Stop the Phase 1 port-forward first. Run this in a dedicated private Bash process; it starts a new forwarder after the
replacement Pod is ready, fails on every unmet gate, and records only HTTP status and health results:

```bash
set -euo pipefail
rotation_port_forward_pid=
rotation_port_forward_log=
cleanup_rotation() {
  if [ -n "${rotation_port_forward_pid:-}" ]; then
    kill "$rotation_port_forward_pid" 2>/dev/null || true
    wait "$rotation_port_forward_pid" 2>/dev/null || true
  fi
  if [ -n "${rotation_port_forward_log:-}" ]; then
    rm -f -- "$rotation_port_forward_log"
  fi
  unset old_api_key new_api_key previous_secret_version current_secret_version
  unset rotation_port_forward_pid rotation_port_forward_log rotation_listener_ready rotation_http_code
}
trap cleanup_rotation EXIT
trap 'exit 1' HUP INT TERM
previous_secret_version=$(kubectl -n hermes get secret hermes-api-auth -o jsonpath='{.metadata.resourceVersion}')
old_api_key=$(kubectl -n hermes get secret hermes-api-auth -o jsonpath='{.data.API_SERVER_KEY}' | base64 -d)
new_api_key=$(openssl rand -hex 32)
op item get --vault infra hermes-runtime --format json | \
  jq --rawfile api_server_key <(printf '%s' "$new_api_key") '
    ([.fields[] | select(.label == "API_SERVER_KEY")] | length) as $count
    | if $count == 1 then
        .fields |= map(if .label == "API_SERVER_KEY" then .type = "CONCEALED" | .value = $api_server_key else . end)
      else
        error("exactly one API_SERVER_KEY field is required")
      end
  ' | op item edit --vault infra hermes-runtime >/dev/null
op item get --vault infra hermes-runtime --format json | \
  jq -e --rawfile api_server_key <(printf '%s' "$new_api_key") \
    '[.fields[] | select(.label == "API_SERVER_KEY" and .value == $api_server_key)] | length == 1' >/dev/null
kubectl -n hermes annotate externalsecret hermes-api-auth force-sync="$(date +%s)" --overwrite
current_secret_version=$previous_secret_version
for _ in $(seq 1 72); do
  current_secret_version=$(kubectl -n hermes get secret hermes-api-auth -o jsonpath='{.metadata.resourceVersion}')
  [ "$current_secret_version" != "$previous_secret_version" ] && break
  sleep 5
done
test "$current_secret_version" != "$previous_secret_version"
kubectl -n hermes delete pod hermes-0
kubectl -n hermes rollout status statefulset/hermes --timeout=15m
rotation_port_forward_log=$(mktemp)
kubectl -n hermes port-forward service/hermes 18642:8642 >"$rotation_port_forward_log" 2>&1 &
rotation_port_forward_pid=$!
rotation_listener_ready=false
for _ in $(seq 1 60); do
  kill -0 "$rotation_port_forward_pid"
  rotation_http_code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18642/health/detailed || true)
  if [ "$rotation_http_code" = 401 ]; then
    rotation_listener_ready=true
    break
  fi
  sleep 1
done
test "$rotation_listener_ready" = true
test "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $old_api_key" \
  http://127.0.0.1:18642/health/detailed)" = 401
curl -fsS -H "Authorization: Bearer $new_api_key" http://127.0.0.1:18642/health/detailed | jq -e \
  '.status == "ok" and .gateway_state == "running"'
argocd app sync hermes --prune=false
cleanup_rotation
trap - EXIT HUP INT TERM
```

Stop and roll back the 1Password value if the Secret does not refresh, the replacement Pod does not become ready, the old
key remains accepted, the replacement port-forward does not become ready, or the new key fails. Use 1Password item history
from a new private shell if the fail-fast process has already exited. ExternalSecret `Ready` alone is not rotation proof.

## Maintenance lock recovery

Every migration and restore shell acquires the fixed `hermes-maintenance` Lease before inspecting or mutating a PVC.
Argo CD globally excludes Kubernetes Lease objects, so `maintenance-lock.sh acquire` atomically creates the canonical Lease on
first use; competing creators still converge on one compare-and-swap lock. Its four-hour duration exceeds the bounded
backup wait, staging Pod, maintenance Job, and rollout windows. If an operator shell disconnects, do not clear the Lease
while a maintenance Job is active. After every Job is terminal, recover the exact observed holder with compare-and-swap
semantics, then restart the interrupted step:

```bash
set -euo pipefail
stale_maintenance_holder=$(kubectl -n hermes get lease hermes-maintenance -o jsonpath='{.spec.holderIdentity}')
test -n "$stale_maintenance_holder"
bash scripts/hermes/wait-for-maintenance.sh --cleanup-restore-stage
bash scripts/hermes/maintenance-lock.sh recover "$stale_maintenance_holder"
unset stale_maintenance_holder
```

## Phase 2: non-secret user-data migration

1. Build a sanitized source archive from the OpenClaw workspace. Only the user profile, memory, and optional skills are
   exported; `.openclaw/openclaw.json`, credentials, tokens, sessions, logs, and operator-managed identity/policy files
   never enter the archive. `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, and `HEARTBEAT.md` remain GitOps-owned:

   ```bash
   set -euo pipefail
   hermes_stage_dir=$(mktemp -d)
   mkdir -p "$hermes_stage_dir/openclaw/workspace"
   if ! (
     set -o pipefail
     virtctl ssh -n openclaw --username ubuntu --identity-file /Users/gregkonush/.ssh/id_ed25519 \
       --local-ssh-opts='-o IdentityAgent=none' --local-ssh-opts='-o IdentitiesOnly=yes' \
       --command='set -eu; cd /home/ubuntu/github.com/lab/services/tuslagch; for path in USER.md memory; do test -r "$path"; done; set -- USER.md memory; for path in MEMORY.md skills; do if test -e "$path" || test -L "$path"; then test -r "$path"; set -- "$@" "$path"; fi; done; tar -czf - "$@"' \
       vm/openclaw </dev/null | tar -xzf - -C "$hermes_stage_dir/openclaw/workspace"
   ); then
     rm -rf -- "$hermes_stage_dir"
     unset hermes_stage_dir
     exit 1
   fi
   if ! bun run scripts/hermes/audit-migration-source.ts "$hermes_stage_dir/openclaw"; then
     rm -rf -- "$hermes_stage_dir"
     unset hermes_stage_dir
     exit 1
   fi
   find "$hermes_stage_dir/openclaw" -type f -print
   ```

   The content audit must pass before any data is copied. It rejects paths outside the explicit user-data allowlist,
   symlinks, non-text content, credential-like or opaque high-entropy values, and bounded-size violations without printing
   detected values. An audit failure blocks migration: inspect the reported file privately, redact or remove only the
   flagged material in `$hermes_stage_dir`, and rerun the unchanged auditor. Never weaken or bypass the patterns. Also review
   the file-name-only inventory and stop if it contains config, credential, token, session, log, or operator-managed
   identity/policy files. `USER.md` and `memory/` are required; `MEMORY.md` and `skills/` are included only when present,
   and any unreadable selected path or descendant fails the pipe.

2. In one dedicated private Bash process, acquire the maintenance Lease for the entire staging, dry-run, and apply
   transaction. Keep this same shell open through step 5. Suspend new backups and wait up to 65 minutes for every active
   backup Job to finish before replacing the staging tree or stopping the gateway; only then does the migration have
   exclusive RBD access:

   ```bash
   set -euo pipefail
   maintenance_holder="migration-$(openssl rand -hex 8)"
   release_maintenance_lock() { bash scripts/hermes/maintenance-lock.sh release "$maintenance_holder"; }
   abort_maintenance() { trap - EXIT HUP INT TERM; release_maintenance_lock; exit 130; }
   bash scripts/hermes/maintenance-lock.sh acquire "$maintenance_holder"
   trap release_maintenance_lock EXIT
   trap abort_maintenance HUP INT TERM
   bash scripts/hermes/wait-for-maintenance.sh
   kubectl -n hermes patch cronjob hermes-backup --type=merge -p '{"spec":{"suspend":true}}'
   backup_wait_deadline=$(( $(date +%s) + 3900 ))
   while [ "$(kubectl -n hermes get jobs -l app.kubernetes.io/name=hermes,app.kubernetes.io/component=backup -o json | jq '[.items[] | select(any(.status.conditions[]?; .status == "True" and (.type == "Complete" or .type == "Failed")) | not)] | length')" -gt 0 ]; do
     if [ "$(date +%s)" -ge "$backup_wait_deadline" ]; then
       kubectl -n hermes get jobs -l app.kubernetes.io/name=hermes,app.kubernetes.io/component=backup -o name >&2
       echo 'active Hermes backup did not terminate; backups remain suspended' >&2
       exit 1
     fi
     sleep 10
   done
   unset backup_wait_deadline
   kubectl -n hermes exec hermes-0 -c hermes -- sh -c \
     'rm -rf -- /opt/data/migration/source && mkdir -p /opt/data/migration/source'
   kubectl -n hermes cp "$hermes_stage_dir/openclaw/." hermes-0:/opt/data/migration/source -c hermes
   rm -rf -- "$hermes_stage_dir"
   unset hermes_stage_dir
   kubectl -n hermes scale statefulset/hermes --replicas=0
   hermes_stop_deadline=$(( $(date +%s) + 600 ))
   while :; do
     hermes_pod_name=$(kubectl -n hermes get pod hermes-0 --ignore-not-found -o name)
     if [ -z "$hermes_pod_name" ]; then
       break
     fi
     if [ "$(date +%s)" -ge "$hermes_stop_deadline" ]; then
       kubectl -n hermes get pod hermes-0 -o wide >&2
       echo 'Hermes gateway did not stop for migration; backups remain suspended' >&2
       exit 1
     fi
     sleep 5
   done
   unset hermes_pod_name hermes_stop_deadline
   ```

3. In the same shell, assert continued Lease ownership, run the merged dry-run Job, and review its complete log. It must
   contain `migration_preview_verified=true conflicts=0 secrets=false`, no secret migration, and no unresolved conflict.
   Exit the shell to release the Lease if the preview is not accepted:

   ```bash
   set -euo pipefail
   test -n "${maintenance_holder:-}"
   test "$(kubectl -n hermes get lease hermes-maintenance -o jsonpath='{.spec.holderIdentity}')" = "$maintenance_holder"
   bash scripts/hermes/wait-for-maintenance.sh
   dry_run_job=$(kubectl -n hermes create -f argocd/applications/hermes/operations/migration-dry-run-job.yaml -o name)
   if ! kubectl -n hermes wait "$dry_run_job" --for=condition=Complete --timeout=10m; then
     kubectl -n hermes logs "$dry_run_job" || true
     kubectl -n hermes delete "$dry_run_job" --wait=true
     echo 'migration dry-run failed or timed out; gateway and backups remain stopped' >&2
     exit 1
   fi
   kubectl -n hermes logs "$dry_run_job"
   kubectl -n hermes logs "$dry_run_job" | grep -Fqx \
     'migration_preview_verified=true conflicts=0 secrets=false'
   ```

4. If the preview is correct, use the same shell and Lease to run the apply Job. Preserve its Job name, log, report summary,
   and generated restore-point archive as migration evidence. The Job verifies its current JSON report, zero
   conflicts/errors, excluded secrets, untouched GitOps-owned identity files, and a current restore point before it can
   complete. It also requires the report to use the production `user_char_limit` of `2200` and `memory_char_limit` of
   `4400`; the stable read-only `hermes-operation-config` is generated from the same `config.yaml` mounted by the gateway.
   Keep the Lease held for the final resync:

   ```bash
   set -euo pipefail
   test -n "${maintenance_holder:-}"
   test "$(kubectl -n hermes get lease hermes-maintenance -o jsonpath='{.spec.holderIdentity}')" = "$maintenance_holder"
   bash scripts/hermes/wait-for-maintenance.sh
   migration_job=$(kubectl -n hermes create -f argocd/applications/hermes/operations/migration-apply-job.yaml -o name)
   if ! kubectl -n hermes wait "$migration_job" --for=condition=Complete --timeout=10m; then
     kubectl -n hermes logs "$migration_job" || true
     kubectl -n hermes delete "$migration_job" --wait=true
     echo 'migration apply failed or timed out; gateway and backups remain stopped' >&2
     exit 1
   fi
   kubectl -n hermes logs "$migration_job"
   kubectl -n hermes logs "$migration_job" | grep -Fq \
     'migration_report_verified=true conflicts=0 errors=0'
   kubectl -n hermes logs "$migration_job" | grep -Fqx \
     'operator_owned_identity_unchanged=true secrets=false'
   ```

5. In the same shell, restore desired replicas through Argo, verify backups are enabled, then release the Lease. Repeat the
   authenticated inference, persistence, and backup checks from Phase 1 after releasing it:

   ```bash
   set -euo pipefail
   test -n "${maintenance_holder:-}"
   test "$(kubectl -n hermes get lease hermes-maintenance -o jsonpath='{.spec.holderIdentity}')" = "$maintenance_holder"
   argocd app sync hermes --prune=false
   kubectl -n hermes rollout status statefulset/hermes --timeout=15m
   test "$(kubectl -n hermes get cronjob hermes-backup -o jsonpath='{.spec.suspend}')" = false
   release_maintenance_lock
   trap - EXIT HUP INT TERM
   unset maintenance_holder
   ```

   If migration is aborted before the final sync, sync the Hermes app before leaving the maintenance window so backups are
   resumed. Do not resume backups while a migration Job is active.

## Phase 3: Discord cutover

Discord activation requires a second PR. That PR must:

- add the name- and namespace-bound `hermes-discord-auth` SealedSecret with only `DISCORD_BOT_TOKEN` and
  `DISCORD_ALLOWED_USERS`;
- leave `hermes-api-auth` and its ExternalSecret responsible only for `API_SERVER_KEY`;
- inject both secret keys into the gateway container;
- set `platforms.discord.enabled: true`;
- set OpenClaw `spec.runStrategy: Halted` and remove the OpenClaw `cluster-admin` binding;
- retain the OpenClaw VM, root-disk PVC, cloud-init Secret, and scoped read-only rollback resources;
- retain manual Argo automation so secret staging, source quiescence, and the full sync are ordered by the operator.

Generate or rotate `discord-sealed-secret.yaml` while OpenClaw is still the sole writer. Use explicit strict scope. Plaintext
may exist only in this private shell and in the two command pipelines; only ciphertext is written to Git:

```bash
set -euo pipefail
cleanup_discord_credentials() {
  unset discord_bot_token discord_allowed_users discord_bot_token_cipher discord_allowed_users_cipher
}
abort_discord_credentials() { trap - EXIT HUP INT TERM; cleanup_discord_credentials; exit 130; }
trap cleanup_discord_credentials EXIT
trap abort_discord_credentials HUP INT TERM
discord_bot_token=$(virtctl ssh -n openclaw --username ubuntu --identity-file /Users/gregkonush/.ssh/id_ed25519 \
  --local-ssh-opts='-o IdentityAgent=none' --local-ssh-opts='-o IdentitiesOnly=yes' \
  --command='set -eu; jq -er '\''.channels.discord.token | select(type == "string" and length >= 20)'\'' /home/ubuntu/.openclaw/openclaw.json' \
  vm/openclaw)
discord_allowed_users=$(virtctl ssh -n openclaw --username ubuntu --identity-file /Users/gregkonush/.ssh/id_ed25519 \
  --local-ssh-opts='-o IdentityAgent=none' --local-ssh-opts='-o IdentitiesOnly=yes' \
  --command='set -eu; jq -er '\''[.channels.discord.allowFrom[]?, .channels.discord.guilds[]?.users[]?] | if length > 0 and all(.[]; type == "string" and test("^[0-9]+$")) then unique | join(",") else error("numeric Discord allowlist required") end'\'' /home/ubuntu/.openclaw/openclaw.json' \
  vm/openclaw)
test "${#discord_bot_token}" -ge 20
case "$discord_allowed_users" in ""|,*|*,|*,,*|*[!0-9,]*) exit 1 ;; esac
discord_bot_token_cipher=$(printf '%s' "$discord_bot_token" | kubeseal --raw --from-file=/dev/stdin \
  --controller-name sealed-secrets --controller-namespace sealed-secrets \
  --namespace hermes --name hermes-discord-auth --scope strict)
discord_allowed_users_cipher=$(printf '%s' "$discord_allowed_users" | kubeseal --raw --from-file=/dev/stdin \
  --controller-name sealed-secrets --controller-namespace sealed-secrets \
  --namespace hermes --name hermes-discord-auth --scope strict)
DISCORD_BOT_TOKEN_CIPHER="$discord_bot_token_cipher" \
DISCORD_ALLOWED_USERS_CIPHER="$discord_allowed_users_cipher" \
  yq -i '
    .spec.encryptedData.DISCORD_BOT_TOKEN = strenv(DISCORD_BOT_TOKEN_CIPHER) |
    .spec.encryptedData.DISCORD_ALLOWED_USERS = strenv(DISCORD_ALLOWED_USERS_CIPHER)
  ' argocd/applications/hermes/discord-sealed-secret.yaml
if rg -q --fixed-strings --file <(printf '%s\n%s\n' "$discord_bot_token" "$discord_allowed_users") \
  argocd/applications/hermes/discord-sealed-secret.yaml; then
  echo 'plaintext Discord credential found in SealedSecret manifest' >&2
  exit 1
fi
kubeseal --validate --controller-name sealed-secrets --controller-namespace sealed-secrets \
  < argocd/applications/hermes/discord-sealed-secret.yaml
printf 'discord_ciphertext_valid=true allowlist_count=%s\n' \
  "$(printf '%s\n' "$discord_allowed_users" | awk -F, '{print NF}')"
cleanup_discord_credentials
trap - EXIT HUP INT TERM
```

Cutover sequence:

1. After the activation PR is merged, resource-sync only the SealedSecret while the live Hermes StatefulSet is still the
   API-only revision. Compare the generated Secret exactly with the OpenClaw source without printing either value, prove
   Hermes has no Discord credential references, then quiesce OpenClaw and prove its gateway process is inactive. A failure
   before the stop leaves OpenClaw as the writer; do not continue on any failure:

   ```bash
   set -euo pipefail
   cleanup_discord_credentials() {
     unset discord_bot_token discord_allowed_users sealed_discord_bot_token sealed_discord_allowed_users
     unset discord_secret_keys hermes_discord_ref_count
   }
   abort_discord_credentials() { trap - EXIT HUP INT TERM; cleanup_discord_credentials; exit 130; }
   trap cleanup_discord_credentials EXIT
   trap abort_discord_credentials HUP INT TERM
   kubeseal --validate --controller-name sealed-secrets --controller-namespace sealed-secrets \
     < argocd/applications/hermes/discord-sealed-secret.yaml
   argocd app sync hermes --prune=false \
     --resource bitnami.com:SealedSecret:hermes-discord-auth
   kubectl -n hermes wait sealedsecret/hermes-discord-auth --for=condition=Synced --timeout=5m
   discord_secret_keys=$(kubectl -n hermes get secret hermes-discord-auth -o json | \
     jq -r '.data | keys | sort | join(",")')
   test "$discord_secret_keys" = DISCORD_ALLOWED_USERS,DISCORD_BOT_TOKEN
   discord_bot_token=$(virtctl ssh -n openclaw --username ubuntu --identity-file /Users/gregkonush/.ssh/id_ed25519 \
     --local-ssh-opts='-o IdentityAgent=none' --local-ssh-opts='-o IdentitiesOnly=yes' \
     --command='set -eu; jq -er '\''.channels.discord.token | select(type == "string" and length >= 20)'\'' /home/ubuntu/.openclaw/openclaw.json' \
     vm/openclaw)
   discord_allowed_users=$(virtctl ssh -n openclaw --username ubuntu --identity-file /Users/gregkonush/.ssh/id_ed25519 \
     --local-ssh-opts='-o IdentityAgent=none' --local-ssh-opts='-o IdentitiesOnly=yes' \
     --command='set -eu; jq -er '\''[.channels.discord.allowFrom[]?, .channels.discord.guilds[]?.users[]?] | if length > 0 and all(.[]; type == "string" and test("^[0-9]+$")) then unique | join(",") else error("numeric Discord allowlist required") end'\'' /home/ubuntu/.openclaw/openclaw.json' \
     vm/openclaw)
   test "${#discord_bot_token}" -ge 20
   case "$discord_allowed_users" in ""|,*|*,|*,,*|*[!0-9,]*) exit 1 ;; esac
   sealed_discord_bot_token=$(kubectl -n hermes get secret hermes-discord-auth \
     -o jsonpath='{.data.DISCORD_BOT_TOKEN}' | base64 -d)
   sealed_discord_allowed_users=$(kubectl -n hermes get secret hermes-discord-auth \
     -o jsonpath='{.data.DISCORD_ALLOWED_USERS}' | base64 -d)
   test "$sealed_discord_bot_token" = "$discord_bot_token"
   test "$sealed_discord_allowed_users" = "$discord_allowed_users"
   hermes_discord_ref_count=$(kubectl -n hermes get statefulset hermes -o json | jq '
     [.spec.template.spec.containers[] | select(.name == "hermes") | .env[]? |
       select(.name == "DISCORD_BOT_TOKEN" or .name == "DISCORD_ALLOWED_USERS")] | length')
   test "$hermes_discord_ref_count" = 0
   printf 'sealed_discord_source_match=true allowlist_count=%s hermes_discord_refs=0\n' \
     "$(printf '%s\n' "$discord_allowed_users" | awk -F, '{print NF}')"
   virtctl ssh -n openclaw --username ubuntu --identity-file /Users/gregkonush/.ssh/id_ed25519 \
     --local-ssh-opts='-o IdentityAgent=none' --local-ssh-opts='-o IdentitiesOnly=yes' \
     --command='set -eu; test "$(systemctl --user show openclaw-gateway.service --property=KillMode --value)" = control-group; systemctl --user stop openclaw-gateway.service; test "$(systemctl --user is-active openclaw-gateway.service || true)" = inactive; test "$(systemctl --user show openclaw-gateway.service --property=MainPID --value)" = 0; sync' \
     vm/openclaw
   cleanup_discord_credentials
   trap - EXIT HUP INT TERM
   ```

2. In a separate maintenance shell, with the source quiesced, repeat Phase 2 steps 1 through 4 from a fresh
   `hermes_stage_dir`. Preserve the new audit output, dry-run Job, apply Job, and restore-point archive as the final
   reconciliation evidence. Do not reuse the earlier archive. Leave the Hermes StatefulSet at zero and backups suspended;
   do not run Phase 2 step 5 because merged `main` now enables Discord. Keep the same Phase 2 shell and Lease open through
   cutover step 4. If this final migration fails, keep Hermes Discord disabled. If cutover is abandoned before the VMI is
   stopped, restart `openclaw-gateway.service`, resync the last API-only Hermes revision, release the Lease, and repeat this
   final reconciliation before any later attempt.
3. In the same shell, assert continued Lease ownership, sync the merged OpenClaw GitOps change, and prove its VMI is gone
   before enabling Hermes Discord:

   ```bash
   set -euo pipefail
   test -n "${maintenance_holder:-}"
   test "$(kubectl -n hermes get lease hermes-maintenance -o jsonpath='{.spec.holderIdentity}')" = "$maintenance_holder"
   if kubectl -n openclaw get clusterrolebinding openclaw-vm-cluster-admin >/dev/null 2>&1; then
     argocd app sync openclaw --prune \
       --resource rbac.authorization.k8s.io:ClusterRoleBinding:openclaw-vm-cluster-admin
   fi
   test -z "$(kubectl -n openclaw get clusterrolebinding openclaw-vm-cluster-admin --ignore-not-found -o name)"
   openclaw_run_state=$(kubectl -n openclaw get virtualmachine openclaw -o json | jq -r '
     if .spec.running == true and (.spec | has("runStrategy") | not) then "legacy-running"
     elif .spec.runStrategy == "Always" and (.spec | has("running") | not) then "runstrategy-running"
     elif .spec.runStrategy == "Halted" and (.spec | has("running") | not) then "halted"
     else "unexpected"
     end')
   case "$openclaw_run_state" in
     legacy-running)
       kubectl -n openclaw patch virtualmachine openclaw --type=json \
         -p='[{"op":"test","path":"/spec/running","value":true},{"op":"remove","path":"/spec/running"},{"op":"add","path":"/spec/runStrategy","value":"Halted"}]'
       ;;
     runstrategy-running)
       kubectl -n openclaw patch virtualmachine openclaw --type=json \
         -p='[{"op":"test","path":"/spec/runStrategy","value":"Always"},{"op":"replace","path":"/spec/runStrategy","value":"Halted"}]'
       ;;
     halted) ;;
     *) echo 'OpenClaw VM has an unexpected run-state schema; refusing cutover' >&2; exit 1 ;;
   esac
   kubectl -n openclaw get virtualmachine openclaw -o json | \
     jq -e '.spec.runStrategy == "Halted" and (.spec | has("running") | not)'
   unset openclaw_run_state
   argocd app sync openclaw --prune=false
   openclaw_stop_deadline=$(( $(date +%s) + 600 ))
   while :; do
     openclaw_vmi_name=$(kubectl -n openclaw get virtualmachineinstance openclaw --ignore-not-found -o name)
     if [ -z "$openclaw_vmi_name" ]; then
       break
     fi
     if [ "$(date +%s)" -ge "$openclaw_stop_deadline" ]; then
       kubectl -n openclaw get virtualmachineinstance openclaw -o wide >&2
       echo 'OpenClaw VMI did not stop; do not enable Hermes Discord' >&2
       exit 1
     fi
     sleep 5
   done
   unset openclaw_vmi_name openclaw_stop_deadline
   ```

4. Keep the Lease-owning shell open. Sync Hermes from merged `main` only after the OpenClaw VMI is gone. Wait for the
   API ExternalSecret, Discord SealedSecret, and rollout; verify backups are enabled, then release the Lease. Prove only one
   Discord bot session is active. This sync restores the Hermes replicas and backups:

   ```bash
   set -euo pipefail
   test -n "${maintenance_holder:-}"
   test "$(kubectl -n hermes get lease hermes-maintenance -o jsonpath='{.spec.holderIdentity}')" = "$maintenance_holder"
   argocd app sync hermes --prune=false
   kubectl -n hermes wait externalsecret/hermes-api-auth --for=condition=Ready --timeout=5m
   kubectl -n hermes wait sealedsecret/hermes-discord-auth --for=condition=Synced --timeout=5m
   kubectl -n hermes rollout status statefulset/hermes --timeout=15m
   api_secret_keys=$(kubectl -n hermes get secret hermes-api-auth -o json | jq -r '.data | keys | sort | join(",")')
   discord_secret_keys=$(kubectl -n hermes get secret hermes-discord-auth -o json | jq -r '.data | keys | sort | join(",")')
   test "$api_secret_keys" = API_SERVER_KEY
   test "$discord_secret_keys" = DISCORD_ALLOWED_USERS,DISCORD_BOT_TOKEN
   unset api_secret_keys discord_secret_keys
   test "$(kubectl -n hermes get cronjob hermes-backup -o jsonpath='{.spec.suspend}')" = false
   test -z "$(kubectl -n openclaw get virtualmachineinstance openclaw --ignore-not-found -o name)"
   test "$(kubectl -n hermes get statefulset hermes -o jsonpath='{.status.readyReplicas}')" = 1
   kubectl -n hermes logs statefulset/hermes -c hermes --since=15m | rg -m1 '\[discord\] Connected as '
   release_maintenance_lock
   trap - EXIT HUP INT TERM
   unset maintenance_holder
   ```

5. From the allowlisted account, send a unique canary message and capture the inbound message ID, Hermes session ID, response
   message ID, and timestamp. Verify a non-allowlisted account is rejected or ignored.
6. Restart `hermes-0`, send a second canary, and verify session/memory continuity plus a current successful backup.

Do not declare cutover complete from pod readiness alone.

## Rollback

Hard rollback triggers are any unauthorized Discord response, non-allowlisted egress, failed authenticated inference for 15
minutes, loss/corruption of migrated state, backup verification failure, or repeated gateway restarts.

### Before Discord cutover

```bash
set -euo pipefail
argocd app sync hermes --revision '<last-known-good-main-sha>' --prune=false
kubectl -n hermes rollout status statefulset/hermes --timeout=15m
```

The OpenClaw runtime remains unchanged and authoritative.

### After Discord cutover

1. Disable Discord in Hermes and stop its pod through a reviewed GitOps rollback.
2. Verify the Hermes VMI-equivalent workload is gone before restarting OpenClaw; never allow both runtimes to connect.
3. Revert OpenClaw to `spec.runStrategy: Always` and restore only its scoped RBAC through GitOps. Restore the token to
   OpenClaw only after Hermes is stopped.
4. Verify OpenClaw's Discord lifecycle and retain Hermes PVCs/backups for investigation.

### Restore Hermes data from a verified backup

Scale Hermes to zero, select a known-good archive, verify its SHA-256 sidecar, and copy it to the fixed restore path. Replace
the archive name below with the reviewed recovery point; never select it only by recency:

```bash
set -euo pipefail
maintenance_holder="restore-$(openssl rand -hex 8)"
release_maintenance_lock() { bash scripts/hermes/maintenance-lock.sh release "$maintenance_holder"; }
abort_maintenance() { trap - EXIT HUP INT TERM; release_maintenance_lock; exit 130; }
bash scripts/hermes/maintenance-lock.sh acquire "$maintenance_holder"
trap release_maintenance_lock EXIT
trap abort_maintenance HUP INT TERM
bash scripts/hermes/wait-for-maintenance.sh --cleanup-restore-stage
kubectl -n hermes patch cronjob hermes-backup --type=merge -p '{"spec":{"suspend":true}}'
backup_wait_deadline=$(( $(date +%s) + 3900 ))
while [ "$(kubectl -n hermes get jobs -l app.kubernetes.io/name=hermes,app.kubernetes.io/component=backup -o json | jq '[.items[] | select(any(.status.conditions[]?; .status == "True" and (.type == "Complete" or .type == "Failed")) | not)] | length')" -gt 0 ]; do
  if [ "$(date +%s)" -ge "$backup_wait_deadline" ]; then
    kubectl -n hermes get jobs -l app.kubernetes.io/name=hermes,app.kubernetes.io/component=backup -o name >&2
    echo 'active Hermes backup did not terminate; backups remain suspended' >&2
    exit 1
  fi
  sleep 10
done
unset backup_wait_deadline
kubectl -n hermes scale statefulset/hermes --replicas=0
hermes_stop_deadline=$(( $(date +%s) + 600 ))
while :; do
  hermes_pod_name=$(kubectl -n hermes get pod hermes-0 --ignore-not-found -o name)
  if [ -z "$hermes_pod_name" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$hermes_stop_deadline" ]; then
    kubectl -n hermes get pod hermes-0 -o wide >&2
    echo 'Hermes gateway did not stop before restore; backups remain suspended' >&2
    exit 1
  fi
  sleep 5
done
unset hermes_pod_name hermes_stop_deadline
bash scripts/hermes/wait-for-maintenance.sh --cleanup-restore-stage
kubectl -n hermes create -f argocd/applications/hermes/operations/restore-stage-pod.yaml
if ! kubectl -n hermes wait pod/hermes-restore-stage --for=condition=Ready --timeout=5m; then
  kubectl -n hermes describe pod/hermes-restore-stage || true
  kubectl -n hermes delete pod/hermes-restore-stage --wait=true
  exit 1
fi
kubectl -n hermes exec hermes-restore-stage -c stage -- \
  find /opt/backups -maxdepth 1 -type f -name 'hermes-backup-*.zip' -print
restore_archive=hermes-backup-YYYYMMDDTHHMMSSZ.zip
if ! kubectl -n hermes exec hermes-restore-stage -c stage -- sh -c \
  '
    set -eu
    cd /opt/backups
    archive=$1
    case "$archive" in */*|"") exit 1 ;; hermes-backup-*.zip) ;; *) exit 1 ;; esac
    test "$(wc -l < "$archive.sha256")" -eq 1
    read -r expected_digest sidecar_archive extra < "$archive.sha256"
    test "${#expected_digest}" -eq 64
    case "$expected_digest" in *[!0-9a-f]*) exit 1 ;; esac
    test "$sidecar_archive" = "$archive"
    test -z "${extra:-}"
    printf "%s  %s\n" "$expected_digest" "$archive" | sha256sum -c -
    cp "$archive" restore.zip
  ' sh "$restore_archive"; then
  kubectl -n hermes delete pod/hermes-restore-stage --wait=true
  exit 1
fi
kubectl -n hermes delete pod hermes-restore-stage --wait=true
bash scripts/hermes/wait-for-maintenance.sh
restore_job=$(kubectl -n hermes create -f argocd/applications/hermes/operations/restore-job.yaml -o name)
if ! kubectl -n hermes wait "$restore_job" --for=condition=Complete --timeout=15m; then
  kubectl -n hermes logs "$restore_job" || true
  kubectl -n hermes delete "$restore_job" --wait=true
  echo 'restore failed or timed out; gateway and backups remain stopped' >&2
  exit 1
fi
kubectl -n hermes logs "$restore_job"
argocd app sync hermes --prune=false
kubectl -n hermes rollout status statefulset/hermes --timeout=15m
test "$(kubectl -n hermes get cronjob hermes-backup -o jsonpath='{.spec.suspend}')" = false
release_maintenance_lock
trap - EXIT HUP INT TERM
unset maintenance_holder
```

Run all Phase 1 checks again after restore. Never overwrite or delete the source archive during the restore. If restore is
aborted, keep backups suspended until every restore Pod and Job is inactive, then sync the Hermes app to resume them.

## Completion evidence

The rollout record is complete only when it includes:

- merged PRs and exact `main` revisions for API canary and Discord cutover;
- image digests and upstream release commit;
- Argo `Synced/Healthy` readback at those revisions;
- ExternalSecret Ready conditions and secret field lengths/counts without values;
- pod UID, read-only rootfs, scoped service-account token, NetworkPolicy, PVC, and verified backup evidence;
- gateway service-account identity, allowed cluster-wide reads, rejected Secret reads and writes, and the lab checkout SHA;
- authenticated API rejection/success, Flamingo model response, and persistence after restart;
- migration dry-run/apply Job identities and report counts;
- single-writer Discord message lifecycle IDs and non-allowlisted-user rejection;
- retained OpenClaw VM/PVC identities, rollback revision, and rollback-window end timestamp.
