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

test('rejects enabling Discord inside the API-only canary', async () => {
  const files = await loadProductionFiles()
  files.config = files.config.replace('discord:\n    enabled: false', 'discord:\n    enabled: true')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.config}: missing production invariant "discord:\\n    enabled: false"`,
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

test('rejects migration or restore without backup quiescence', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace(
    'kubectl -n hermes patch cronjob hermes-backup --type=merge -p \'{"spec":{"suspend":true}}\'\n',
    '',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: migration and restore must both suspend the backup CronJob`,
  )
})

test('rejects API key rotation without restart proof', async () => {
  const files = await loadProductionFiles()
  files.runbook = files.runbook.replace('## API key rotation', '## API credential maintenance')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "## API key rotation"`,
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
