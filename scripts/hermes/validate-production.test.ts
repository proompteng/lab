import { expect, test } from 'bun:test'

import { loadProductionFiles, productionPaths, validateProductionContent } from './validate-production'

test('accepts the committed Hermes production surfaces', async () => {
  expect(validateProductionContent(await loadProductionFiles())).toEqual([])
})

test('rejects a mutable Hermes runtime image', async () => {
  const files = await loadProductionFiles()
  files.statefulSet = files.statefulSet.replace(
    /registry\.ide-newton\.ts\.net\/lab\/hermes-agent@sha256:[a-f0-9]+/,
    'registry.ide-newton.ts.net/lab/hermes-agent:latest',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.statefulSet}: the bootstrap and gateway containers must use the mirrored immutable amd64 digest`,
  )
})

test('rejects release evidence that does not enforce the mirrored digest', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'test "$mirror_digest" = sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a',
    'printf \'%s\\n\' "$mirror_digest"',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "test \\"$mirror_digest\\" = sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a"`,
  )
})

test('rejects rollout evidence that permits an Argo revision mismatch', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace('test "$hermes_revision" = "$main_revision"', 'true')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "test \\"$hermes_revision\\" = \\"$main_revision\\""`,
  )
})

test('rejects disabling Discord after the cutover', async () => {
  const files = await loadProductionFiles()
  files.config = files.config.replace('discord:\n    enabled: true', 'discord:\n    enabled: false')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.config}: missing production invariant "discord:\\n    enabled: true"`,
  )
})

test('rejects a Discord token without a matching gateway SecretKeyRef', async () => {
  const files = await loadProductionFiles()
  files.statefulSet = files.statefulSet.replace('- name: DISCORD_BOT_TOKEN\n', '- name: DISCORD_BOT_TOKEN_DISABLED\n')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.statefulSet}: DISCORD_BOT_TOKEN must have exactly one matching hermes-discord-auth SecretKeyRef`,
  )
})

test('rejects a Discord allowlist missing from the SealedSecret', async () => {
  const files = await loadProductionFiles()
  files.discordSealedSecret = files.discordSealedSecret.replace(
    '    DISCORD_ALLOWED_USERS:',
    '    DISCORD_ALLOWED_USERS_DISABLED:',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.discordSealedSecret}: encryptedData must contain exactly the Discord token and allowlist`,
  )
})

test('rejects Discord fields in the API ExternalSecret', async () => {
  const files = await loadProductionFiles()
  files.externalSecret += '\n    - secretKey: DISCORD_BOT_TOKEN\n'

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.externalSecret}: contains forbidden production term "DISCORD_BOT_TOKEN"`,
  )
})

test('rejects a broadly scoped Discord SealedSecret', async () => {
  const files = await loadProductionFiles()
  files.discordSealedSecret += '\n    sealedsecrets.bitnami.com/namespace-wide: "true"\n'

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.discordSealedSecret}: contains forbidden production term "sealedsecrets.bitnami.com/namespace-wide"`,
  )
})

test('rejects a cutover that leaves the OpenClaw VM running', async () => {
  const files = await loadProductionFiles()
  files.openClawVirtualMachine = files.openClawVirtualMachine.replace('runStrategy: Halted', 'runStrategy: Always')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.openClawVirtualMachine}: missing production invariant "runStrategy: Halted"`,
  )
})

test('rejects the deprecated KubeVirt running field', async () => {
  const files = await loadProductionFiles()
  files.openClawVirtualMachine = files.openClawVirtualMachine.replace('runStrategy: Halted', 'running: false')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.openClawVirtualMachine}: contains forbidden production term "running: false"`,
  )
})

test('rejects retaining OpenClaw cluster-admin authority', async () => {
  const files = await loadProductionFiles()
  files.openClawRbac += '\nroleRef:\n  name: cluster-admin\n'

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.openClawRbac}: contains forbidden production term "name: cluster-admin"`,
  )
})

test('rejects whole-application pruning during OpenClaw cutover', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'argocd app sync openclaw --prune \\\n       --resource rbac.authorization.k8s.io:ClusterRoleBinding:openclaw-vm-cluster-admin',
    'argocd app sync openclaw --prune=true',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: contains forbidden production term "argocd app sync openclaw --prune=true"`,
  )
})

test('rejects non-idempotent cluster-admin pruning during OpenClaw cutover', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'if kubectl -n openclaw get clusterrolebinding openclaw-vm-cluster-admin >/dev/null 2>&1; then',
    'if true; then',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "if kubectl -n openclaw get clusterrolebinding openclaw-vm-cluster-admin >/dev/null 2>&1; then"`,
  )
})

test('rejects an OpenClaw sync without an admission-safe runStrategy transition', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    '-p=\'[{"op":"test","path":"/spec/running","value":true},{"op":"remove","path":"/spec/running"},{"op":"add","path":"/spec/runStrategy","value":"Halted"}]\'',
    '-p=\'[{"op":"add","path":"/spec/runStrategy","value":"Halted"}]\'',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "-p='[{\\"op\\":\\"test\\",\\"path\\":\\"/spec/running\\",\\"value\\":true},{\\"op\\":\\"remove\\",\\"path\\":\\"/spec/running\\"},{\\"op\\":\\"add\\",\\"path\\":\\"/spec/runStrategy\\",\\"value\\":\\"Halted\\"}]'"`,
  )
})

test('rejects stopping the source before the sealed credentials match', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    '   test "$sealed_discord_bot_token" = "$discord_bot_token"',
    '   systemctl --user stop openclaw-gateway.service\n   test "$sealed_discord_bot_token" = "$discord_bot_token"',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: Discord cutover operations are out of order`,
  )
})

test('rejects a gateway quiescence check that matches its own remote shell', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'test "$(systemctl --user show openclaw-gateway.service --property=MainPID --value)" = 0',
    'if pgrep -f "[o]penclaw.*gateway" >/dev/null; then exit 1; fi',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "test \\"$(systemctl --user show openclaw-gateway.service --property=MainPID --value)\\" = 0"`,
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: contains forbidden production term "pgrep -f \\"[o]penclaw.*gateway\\""`,
  )
})

test('rejects a full Hermes sync before the OpenClaw VMI is absent', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    '   argocd app sync openclaw --prune=false\n',
    '   argocd app sync hermes --prune=false\n   argocd app sync openclaw --prune=false\n',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: Discord cutover operations are out of order`,
  )
})

test('rejects plaintext fields in the Discord SealedSecret', async () => {
  const files = await loadProductionFiles()
  files.discordSealedSecret = files.discordSealedSecret.replace(
    '  encryptedData:\n',
    '  stringData:\n    DISCORD_BOT_TOKEN: plaintext\n  encryptedData:\n',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.discordSealedSecret}: contains forbidden production term "\\n  stringData:"`,
  )
})

test('rejects a Discord credential transfer without exact-value verification', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'test "$sealed_discord_bot_token" = "$discord_bot_token"',
    'test "${#sealed_discord_bot_token}" -ge 20',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "test \\"$sealed_discord_bot_token\\" = \\"$discord_bot_token\\""`,
  )
})

test('rejects secret bridge verification that does not enforce key length', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'test "$api_key_bytes" -ge 32\n   printf \'%s\\n\' "$api_key_bytes"',
    'echo "$api_key_bytes"',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: 1Password and bridged API keys must both enforce the minimum length`,
  )
})

test('rejects a network-policy probe without a deny rule', async () => {
  const files = await loadProductionFiles()
  files.networkPolicyProbe = files.networkPolicyProbe.replace('  egress: []\n', '  egress:\n    - {}\n')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.networkPolicyProbe}: missing production invariant "egress: []"`,
  )
})

test('rejects a network-policy probe without bounded Pods', async () => {
  const files = await loadProductionFiles()
  files.networkPolicyProbe = files.networkPolicyProbe.replace('  activeDeadlineSeconds: 600\n', '')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.networkPolicyProbe}: both probe Pods must enforce "activeDeadlineSeconds: 600"`,
  )
})

test('rejects treating arbitrary probe failures as policy enforcement', async () => {
  const files = await loadProductionFiles()
  files.networkPolicyProbe = files.networkPolicyProbe.replace(
    'if [[ "$request_status" -eq 42 ]]',
    'if [[ "$request_status" -ne 0 ]]',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.networkPolicyProbe}: missing production invariant "if [[ \\"$request_status\\" -eq 42 ]]"`,
  )
})

test('rejects treating HTTP error responses as policy enforcement', async () => {
  const files = await loadProductionFiles()
  files.networkPolicyProbe = files.networkPolicyProbe.replace(
    'except urllib.error.HTTPError:\n    raise SystemExit(43)\nexcept (TimeoutError, OSError, urllib.error.URLError):',
    'except (TimeoutError, OSError, urllib.error.URLError):\n    raise SystemExit(42)\nexcept urllib.error.HTTPError:',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.networkPolicyProbe}: HTTP responses must not count as policy denials`,
  )
})

test('rejects policy enforcement proof without connectivity restoration', async () => {
  const files = await loadProductionFiles()
  files.networkPolicyProbe = files.networkPolicyProbe.replace(
    'if [[ "$policy_released" != true ]]',
    'if [[ "$policy_released" == true ]]',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.networkPolicyProbe}: missing production invariant "if [[ \\"$policy_released\\" != true ]]"`,
  )
})

test('rejects syncing Hermes before network-policy enforcement proof', async () => {
  const files = await loadProductionFiles()
  const probeCommand = '   bash scripts/hermes/verify-network-policy-enforcement.sh\n'
  files.runbook = files.runbook.replace(probeCommand, '')
  files.runbook = files.runbook.replace(
    '   argocd app sync hermes --prune=false\n',
    `   argocd app sync hermes --prune=false\n${probeCommand}`,
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: NetworkPolicy enforcement must be proven before the first Hermes sync`,
  )
})

test('rejects automatic Argo reconciliation during the staged migration', async () => {
  const files = await loadProductionFiles()
  files.platform = files.platform.replace(/(\n\s+- name: hermes\n[\s\S]*?automation:) manual/, '$1 auto')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.platform}: missing production invariant "automation: manual"`,
  )
})

test('rejects automatic OpenClaw reconciliation during credential transfer', async () => {
  const files = await loadProductionFiles()
  files.platform = files.platform.replace(/(\n\s+- name: openclaw\n[\s\S]*?automation:) manual/, '$1 auto')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.platform}: missing production invariant "automation: manual"`,
  )
})

test('rejects secret migration in the apply Job', async () => {
  const files = await loadProductionFiles()
  files.migrationApply = files.migrationApply.replace(
    '                  --yes 2>&1',
    '                  --migrate-secrets \\\n                  --yes 2>&1',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.migrationApply}: contains forbidden production term "--migrate-secrets"`,
  )
})

test('rejects an operation that can schedule on arm64', async () => {
  const files = await loadProductionFiles()
  files.restore = files.restore.replace('      nodeSelector:\n        kubernetes.io/arch: amd64\n', '')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.restore}: missing production invariant "kubernetes.io/arch: amd64"`,
  )
})

test('rejects an operation without a controller-enforced deadline', async () => {
  const files = await loadProductionFiles()
  files.migrationApply = files.migrationApply.replace('  activeDeadlineSeconds: 600\n', '')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.migrationApply}: missing production invariant "activeDeadlineSeconds: 600"`,
  )
})

test('rejects coupling backup health to gateway pod readiness', async () => {
  const files = await loadProductionFiles()
  files.statefulSet += '\n        - name: backup\n          readinessProbe: {}\n'

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.statefulSet}: contains forbidden production term "        - name: backup\\n"`,
  )
})

test('rejects a backup CronJob without independent retry behavior', async () => {
  const files = await loadProductionFiles()
  files.backupCronJob = files.backupCronJob.replace('restartPolicy: OnFailure', 'restartPolicy: Never')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.backupCronJob}: missing production invariant "restartPolicy: OnFailure"`,
  )
})

test('rejects a backup CronJob that cannot be suspended deterministically', async () => {
  const files = await loadProductionFiles()
  files.backupCronJob = files.backupCronJob.replace('suspend: false', 'suspend: true')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.backupCronJob}: missing production invariant "suspend: false"`,
  )
})

test('rejects publishing a backup archive before its verified checksum', async () => {
  const files = await loadProductionFiles()
  files.backupScript = files.backupScript.replace(
    'mv -- "$pending_checksum" "$archive.sha256"\nmv -- "$pending_archive" "$archive"',
    'mv -- "$pending_archive" "$archive"\nmv -- "$pending_checksum" "$archive.sha256"',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.backupScript}: backup must verify the hidden archive before publishing its checksum and archive`,
  )
})

test('rejects a read-only data mount that prevents SQLite WAL-safe backup', async () => {
  const files = await loadProductionFiles()
  files.backupCronJob = files.backupCronJob.replaceAll('readOnly: false', 'readOnly: true')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.backupCronJob}: missing production invariant "claimName: data-hermes-0\\n                readOnly: false"`,
  )
})

test('rejects publishing a backup after SQLite falls back to a raw copy', async () => {
  const files = await loadProductionFiles()
  files.backupScript = files.backupScript.replace('*"SQLite safe copy failed"*|', '')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.backupScript}: missing production invariant "*\\\"SQLite safe copy failed\\\"*|*\\\"Raw copy also failed\\\"*|*\\\"Warnings (\\\"*)"`,
  )
})

test('rejects a backup without archived SQLite integrity checks', async () => {
  const files = await loadProductionFiles()
  files.backupScript = files.backupScript.replace('connection.execute("PRAGMA quick_check")', '[("ok",)]')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.backupScript}: missing production invariant "connection.execute(\\\"PRAGMA quick_check\\\")"`,
  )
})

test('rejects availability alerts that ignore missing metrics', async () => {
  const files = await loadProductionFiles()
  files.mimirRules = files.mimirRules.replace(
    'absent(\n                  kube_statefulset_status_replicas_ready{',
    'vector(0) or (',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.mimirRules}: missing production invariant "absent(\\n                  kube_statefulset_status_replicas_ready{"`,
  )
})

test('rejects a telemetry pipeline that drops Hermes workload metrics', async () => {
  const files = await loadProductionFiles()
  files.kubeStateMetrics = files.kubeStateMetrics.replace('  - cronjobs\n', '')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.kubeStateMetrics}: missing production invariant "  - cronjobs"`,
  )
})

test('rejects changing the telemetry allowlist without rolling Alloy', async () => {
  const files = await loadProductionFiles()
  files.clusterMetricsDeployment = files.clusterMetricsDeployment.replace(
    /observability\.proompteng\.ai\/config-sha256: [a-f0-9]+/,
    'observability.proompteng.ai/config-sha256: stale',
  )

  expect(validateProductionContent(files)).toContainEqual(
    expect.stringContaining(`${productionPaths.clusterMetricsDeployment}: missing production invariant`),
  )
})

test('rejects alerting before the first scheduled backup window expires', async () => {
  const files = await loadProductionFiles()
  files.mimirRules = files.mimirRules.replace('time() - kube_cronjob_created{', 'vector(1) + kube_cronjob_created{')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.mimirRules}: missing production invariant "time() - kube_cronjob_created{"`,
  )
})

test('rejects absent-series alerts that fire before rollout enablement', async () => {
  const files = await loadProductionFiles()
  files.mimirRules = files.mimirRules.replace('(hermes_rollout_enabled == 1)', 'vector(1)')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.mimirRules}: all absent-series alerts must be gated on rollout enablement`,
  )
})

test('rejects rollout enablement derived from ephemeral Hermes namespace state', async () => {
  const files = await loadProductionFiles()
  files.mimirRules = files.mimirRules.replace(
    'kube_argocd_application_deployment_history_info{',
    'kube_namespace_labels{',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.mimirRules}: missing production invariant "kube_argocd_application_deployment_history_info{"`,
  )
})

test('rejects migration instructions that skip the content audit', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'bun run scripts/hermes/audit-migration-source.ts "$hermes_stage_dir/openclaw"',
    'false',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "bun run scripts/hermes/audit-migration-source.ts \\"$hermes_stage_dir/openclaw\\""`,
  )
})

test('rejects Discord cutover without a final stopped-source reconciliation', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'repeat Phase 2 steps 1 through 4 from a fresh',
    'reuse the earlier migration archive',
  )

  const invariant = 'repeat Phase 2 steps 1 through 4 from a fresh'
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant ${JSON.stringify(invariant)}`,
  )
})

test('rejects migration or restore creation without maintenance serialization', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    '   bash scripts/hermes/wait-for-maintenance.sh\n   migration_job=',
    '   migration_job=',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: every migration and restore operation must wait for maintenance Jobs`,
  )
})

test('rejects maintenance operations without an atomic Lease', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    '   bash scripts/hermes/maintenance-lock.sh acquire "$maintenance_holder"\n',
    '',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: every maintenance operation must acquire the atomic Lease`,
  )
})

test('rejects a maintenance lock that cannot bootstrap the Argo-excluded Lease', async () => {
  const files = await loadProductionFiles()
  files.maintenanceLock = files.maintenanceLock.replace('    ensure_lease\n', '')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.maintenanceLock}: missing production invariant "    ensure_lease"`,
  )
})

test('rejects a Lease renewTime without Kubernetes MicroTime precision', async () => {
  const files = await loadProductionFiles()
  files.maintenanceLock = files.maintenanceLock.replace(
    'date -u +%Y-%m-%dT%H:%M:%S.000000Z',
    'date -u +%Y-%m-%dT%H:%M:%SZ',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.maintenanceLock}: missing production invariant "date -u +%Y-%m-%dT%H:%M:%S.000000Z"`,
  )
})

test('rejects declaring the globally excluded maintenance Lease as an Argo resource', async () => {
  const files = await loadProductionFiles()
  files.kustomization = files.kustomization.replace(
    '  - serviceaccount.yaml\n',
    '  - serviceaccount.yaml\n  - maintenance-lease.yaml\n',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.kustomization}: contains forbidden production term "maintenance-lease.yaml"`,
  )
})

test('rejects incomplete normalization of StatefulSet PVC template defaults', async () => {
  const files = await loadProductionFiles()
  const hermesApplication = files.platform.match(/\n\s+- name: hermes\n[\s\S]*?\n\s+- name: workers\n/)?.[0] ?? ''
  files.platform = files.platform.replace(
    hermesApplication,
    hermesApplication.replace('                      - .spec.volumeClaimTemplates[].status\n', ''),
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.platform}: missing production invariant "- .spec.volumeClaimTemplates[].status"`,
  )
})

test('rejects the invalid namespace name-plus-selector rollout check', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    '   kubectl -n hermes get namespace hermes -o json |',
    '   kubectl -n hermes get namespace hermes -l observability.proompteng.ai/hermes-rollout-enabled=true -o json |',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "kubectl -n hermes get namespace hermes -o json"`,
  )
})

test('rejects creating the one-off backup outside the maintenance Lease', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    '   initial_backup_job="hermes-backup-initial-$(date -u +%Y%m%d%H%M%S)"\n',
    '   release_maintenance_lock\n   initial_backup_job="hermes-backup-initial-$(date -u +%Y%m%d%H%M%S)"\n',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: the one-off canary backup must hold the maintenance Lease`,
  )
})

test('rejects releasing the migration Lease before apply completes', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    '   unset hermes_pod_name hermes_stop_deadline\n',
    '   unset hermes_pod_name hermes_stop_deadline\n   release_maintenance_lock\n',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: migration must hold one Lease from staging through apply`,
  )
})

test('rejects releasing the cutover Lease before Hermes is restored', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    '   argocd app sync openclaw --prune=false\n',
    '   release_maintenance_lock\n   argocd app sync openclaw --prune=false\n',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: cutover must hold the migration Lease until Hermes is restored`,
  )
})

test('rejects a maintenance lock without compare-and-swap acquisition', async () => {
  const files = await loadProductionFiles()
  files.maintenanceLock = files.maintenanceLock.replace(
    '{op: "test", path: "/spec/holderIdentity", value: $expected}',
    '{op: "replace", path: "/spec/holderIdentity", value: $expected}',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.maintenanceLock}: missing production invariant "{op: \\"test\\", path: \\"/spec/holderIdentity\\", value: $expected}"`,
  )
})

test('rejects restore staging without stale Pod cleanup', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'bash scripts/hermes/wait-for-maintenance.sh --cleanup-restore-stage\nkubectl -n hermes create -f argocd/applications/hermes/operations/restore-stage-pod.yaml',
    'kubectl -n hermes create -f argocd/applications/hermes/operations/restore-stage-pod.yaml',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: restore staging must clean up a stale staging Pod before create`,
  )
})

test('rejects maintenance instructions that fail when the gateway is already absent', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace('get pod hermes-0 --ignore-not-found -o name', 'get pod hermes-0 -o name')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: migration and restore must treat an already-absent Hermes gateway as stopped`,
  )
})

test('rejects cutover instructions that fail when the OpenClaw VMI is already absent', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'get virtualmachineinstance openclaw --ignore-not-found -o name',
    'wait virtualmachineinstance/openclaw --for=delete',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "openclaw_vmi_name=$(kubectl -n openclaw get virtualmachineinstance openclaw --ignore-not-found -o name)"`,
  )
})

test('rejects non-idempotent initial 1Password provisioning', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'hermes_item_count=$(op item list --vault infra --format json',
    'hermes_item_count=0 # skip existing-item discovery',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "hermes_item_count=$(op item list --vault infra --format json"`,
  )
})

test('rejects initial 1Password provisioning that does not fail on duplicate items', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'multiple hermes-runtime items found; reconcile them before continuing',
    'continuing with an arbitrary hermes-runtime item',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "multiple hermes-runtime items found; reconcile them before continuing"`,
  )
})

test('rejects canary, migration, or restore without backup quiescence', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'kubectl -n hermes patch cronjob hermes-backup --type=merge -p \'{"spec":{"suspend":true}}\'\n',
    '',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: canary, migration, and restore must suspend the backup CronJob`,
  )
})

test('rejects a partial archive that ignores unreadable migration inputs', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace('tar -czf - "$@"', 'tar --ignore-failed-read -czf - "$@"')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: contains forbidden production term "--ignore-failed-read"`,
  )
})

test('rejects a containment check that aborts on expected direct-egress denial', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'if kubectl -n hermes exec hermes-0 -c hermes -- /opt/hermes/.venv/bin/python -c',
    'kubectl -n hermes exec hermes-0 -c hermes -- /opt/hermes/.venv/bin/python -c',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "if kubectl -n hermes exec hermes-0 -c hermes -- /opt/hermes/.venv/bin/python -c"`,
  )
})

test('rejects migration staging that overlays a previous source tree', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    "'rm -rf -- /opt/data/migration/source && mkdir -p /opt/data/migration/source'",
    "'mkdir -p /opt/data/migration/source'",
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "'rm -rf -- /opt/data/migration/source && mkdir -p /opt/data/migration/source'"`,
  )
})

test('rejects migration staging that races an active backup', async () => {
  const files = await loadProductionFiles()
  const stagingCommand =
    "   kubectl -n hermes exec hermes-0 -c hermes -- sh -c \\\n     'rm -rf -- /opt/data/migration/source && mkdir -p /opt/data/migration/source'\n"
  files.runbook = files.runbook.replace(stagingCommand, '')
  const phaseTwoStart = files.runbook.indexOf('## Phase 2:')
  const phaseTwo = files.runbook
    .slice(phaseTwoStart)
    .replace(
      '   kubectl -n hermes patch cronjob hermes-backup',
      `${stagingCommand}   kubectl -n hermes patch cronjob hermes-backup`,
    )
  files.runbook = files.runbook.slice(0, phaseTwoStart) + phaseTwo

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: migration must quiesce backups before replacing the staging tree`,
  )
})

test('rejects staging GitOps-owned identity or policy files', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'for path in USER.md memory; do test -r "$path"; done',
    'for path in AGENTS.md USER.md memory; do test -r "$path"; done',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "for path in USER.md memory; do test -r \\"$path\\"; done"`,
  )
})

test('rejects an apply Job that trusts the migration command exit code alone', async () => {
  const files = await loadProductionFiles()
  files.migrationApply = files.migrationApply.replace(
    'migration_report_verified=true',
    'migration_command_finished=true',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.migrationApply}: missing production invariant "migration_report_verified=true"`,
  )
})

test('rejects an apply Job without runtime proof that secrets are disabled', async () => {
  const files = await loadProductionFiles()
  files.migrationApply = files.migrationApply.replace(
    'migration apply did not prove that secret migration is disabled',
    'migration apply secret mode was not checked',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.migrationApply}: missing production invariant "migration apply did not prove that secret migration is disabled"`,
  )
})

test('rejects migration Jobs without the stable production config', async () => {
  const files = await loadProductionFiles()
  files.migrationApply = files.migrationApply.replace('name: hermes-operation-config', 'name: missing-config')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.migrationApply}: missing production invariant "name: hermes-operation-config"`,
  )
})

test('rejects an apply Job that does not verify both production character limits', async () => {
  const files = await loadProductionFiles()
  files.migrationApply = files.migrationApply.replace(
    "expected_char_limits = {'user-profile': 2200, 'daily-memory': 4400}",
    "expected_char_limits = {'user-profile': 4400, 'daily-memory': 4400}",
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.migrationApply}: missing production invariant "expected_char_limits = {'user-profile': 2200, 'daily-memory': 4400}"`,
  )
})

test('rejects a source guard that treats normal skipped directories as fatal', async () => {
  const files = await loadProductionFiles()
  files.migrationDryRun = files.migrationDryRun.replace(
    'directory not found: /opt/data/migration/source',
    'directory not found',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.migrationDryRun}: missing production invariant "directory not found: /opt/data/migration/source"`,
  )
})

test('rejects restore archive selection that expands the glob on the operator host', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    "find /opt/backups -maxdepth 1 -type f -name 'hermes-backup-*.zip' -print",
    'ls -1 /opt/backups/hermes-backup-*.zip',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "find /opt/backups -maxdepth 1 -type f -name 'hermes-backup-*.zip' -print"`,
  )
})

test('rejects restore verification that is not bound to the selected archive', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace('test "$sidecar_archive" = "$archive"', 'test -n "$sidecar_archive"')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "test \\"$sidecar_archive\\" = \\"$archive\\""`,
  )
})

test('rejects API key rotation without restart proof', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace('## API key rotation', '## API credential maintenance')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "## API key rotation"`,
  )
})

test('rejects API key rotation that does not fail closed', async () => {
  const files = await loadProductionFiles()
  const rotationStart = files.runbook.indexOf('## API key rotation')
  files.runbook =
    files.runbook.slice(0, rotationStart) + files.runbook.slice(rotationStart).replace('set -euo pipefail', 'set +e')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "set -euo pipefail"`,
  )
})

test('rejects API key rotation that reuses the terminated port-forward', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'kubectl -n hermes port-forward service/hermes 18642:8642 >"$rotation_port_forward_log" 2>&1 &',
    '',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "kubectl -n hermes port-forward service/hermes 18642:8642"`,
  )
})

test('rejects removing Hermes surfaces from production validation routing', async () => {
  const files = await loadProductionFiles()
  files.impactMap = files.impactMap.replace('      - docs/runbooks/hermes-production-rollout.md\n', '')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.impactMap}: missing production invariant "- docs/runbooks/hermes-production-rollout.md"`,
  )
})

test('rejects a PR workflow that omits migration audit tests', async () => {
  const files = await loadProductionFiles()
  files.pullRequestWorkflow = files.pullRequestWorkflow.replace(
    'bun test scripts/hermes/*.test.ts',
    'bun test scripts/hermes/validate-production.test.ts',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.pullRequestWorkflow}: missing production invariant "bun test scripts/hermes/*.test.ts"`,
  )
})
