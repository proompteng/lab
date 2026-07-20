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

test('rejects enabling Discord inside the API-only canary', async () => {
  const files = await loadProductionFiles()
  files.config = files.config.replace('discord:\n    enabled: false', 'discord:\n    enabled: true')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.config}: missing production invariant "discord:\\n    enabled: false"`,
  )
})

test('rejects secret bridge verification that does not enforce key length', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace('test "$api_key_bytes" -ge 32', 'echo "$api_key_bytes"')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "test \\"$api_key_bytes\\" -ge 32"`,
  )
})

test('rejects automatic Argo reconciliation during the staged migration', async () => {
  const files = await loadProductionFiles()
  files.platform = files.platform.replace(/(\n\s+- name: hermes\n[\s\S]*?automation:) manual/, '$1 auto')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.platform}: missing production invariant "automation: manual"`,
  )
})

test('rejects secret migration in the apply Job', async () => {
  const files = await loadProductionFiles()
  files.migrationApply = files.migrationApply.replace(
    '            - --yes',
    '            - --migrate-secrets\n            - --yes',
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

test('rejects rollout enablement that expires after namespace loss', async () => {
  const files = await loadProductionFiles()
  files.mimirRules = files.mimirRules.replace(
    'or\n                hermes_rollout_enabled',
    'or\n                vector(0)',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.mimirRules}: missing production invariant "or\\n                hermes_rollout_enabled"`,
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
    "'rm -rf -- /opt/data/migration/openclaw && mkdir -p /opt/data/migration/openclaw'",
    "'mkdir -p /opt/data/migration/openclaw'",
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "'rm -rf -- /opt/data/migration/openclaw && mkdir -p /opt/data/migration/openclaw'"`,
  )
})

test('rejects migration staging that races an active backup', async () => {
  const files = await loadProductionFiles()
  const stagingCommand =
    "   kubectl -n hermes exec hermes-0 -c hermes -- sh -c \\\n     'rm -rf -- /opt/data/migration/openclaw && mkdir -p /opt/data/migration/openclaw'\n"
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
