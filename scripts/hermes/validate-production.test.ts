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
    `${productionPaths.statefulSet}: all three Hermes containers must use the mirrored immutable amd64 digest`,
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

test('rejects a backup readiness probe without freshness enforcement', async () => {
  const files = await loadProductionFiles()
  files.statefulSet = files.statefulSet.replace(
    'find /opt/backups/last-success -mmin -1560 -print -quit | grep -q .',
    'test -s /opt/backups/last-success',
  )

  expect(validateProductionContent(files)).toContain(
    `${productionPaths.statefulSet}: backup startup, readiness, and liveness probes must all enforce freshness`,
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
