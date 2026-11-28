import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import { parse, parseAllDocuments } from 'yaml'

import { repoRoot } from '../../shared/cli'

const readArgoFile = (path: string) => readFileSync(join(repoRoot, 'argocd', path), 'utf8')

test.each([
  ['attic/gc-cronjob.yaml', 'attic-gc', 2, 1800],
  ['hermes/backup-cronjob.yaml', 'hermes-backup', 2, 14400],
  ['paperless/backup-retention.yaml', 'paperless-backup-retention', 2, 1800],
  ['registry/cleanup-cronjob.yaml', 'registry-cleanup', 2, 14400],
  ['restate/snapshot-restore-drill-cronjob.yaml', 'restate-snapshot-restore-drill', 1, 43200],
  ['torghut/clickhouse/signal-publisher-cronjob.yaml', 'signal-adjusted-daily-publisher', 2, 1800],
] as const)('%s bounds finished Job retention', (path, name, failed, ttl) => {
  const resources = parseAllDocuments(readArgoFile(`applications/${path}`)).map((document) => document.toJSON())
  const spec = resources.find((resource) => resource?.kind === 'CronJob' && resource.metadata.name === name)?.spec

  expect(spec?.successfulJobsHistoryLimit).toBe(1)
  expect(spec?.failedJobsHistoryLimit).toBe(failed)
  expect(spec?.jobTemplate?.spec?.ttlSecondsAfterFinished).toBe(ttl)
})

test('Kargo sets finished Job retention through the garbage collector chart values', () => {
  const appSet = parse(readArgoFile('applicationsets/helm-apps.yaml'))
  const applications = appSet.spec.generators[0].matrix.generators[1].list.elements
  const values = applications.find((application: { name: string }) => application.name === 'kargo')?.valuesObject

  expect(values?.garbageCollector?.successfulJobsHistoryLimit).toBe(1)
  expect(values?.garbageCollector?.failedJobsHistoryLimit).toBe(1)
  expect(values?.garbageCollector?.ttlSecondsAfterFinished).toBe(1800)
})
