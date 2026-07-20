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

test('rejects availability alerts that ignore missing metrics', async () => {
  const files = await loadProductionFiles()
  files.mimirRules = files.mimirRules.replace(
    'absent(\n                kube_statefulset_status_replicas_ready{',
    'vector(0) or (',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.mimirRules}: missing production invariant "absent(\\n                kube_statefulset_status_replicas_ready{"`,
  )
})

test('rejects removing Hermes surfaces from production validation routing', async () => {
  const files = await loadProductionFiles()
  files.impactMap = files.impactMap.replace('      - docs/runbooks/hermes-production-rollout.md\n', '')

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.impactMap}: missing production invariant "- docs/runbooks/hermes-production-rollout.md"`,
  )
})
