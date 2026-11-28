import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

type SecretRef = { name: string; key: string }
type Container = {
  name: string
  image: string
  command: string[]
  args: string[]
  envFrom?: unknown[]
  env: { name: string; value?: string; valueFrom?: { secretKeyRef?: SecretRef } }[]
  volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[]
}
type PodSpec = {
  serviceAccountName: string
  automountServiceAccountToken: boolean
  containers: Container[]
  initContainers?: unknown[]
  volumes: {
    name: string
    secret?: { secretName: string; items: { key: string; path: string }[] }
    persistentVolumeClaim?: { claimName: string; readOnly?: boolean }
  }[]
}
type CronJob = {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace: string }
  spec: {
    timeZone: string
    schedule: string
    concurrencyPolicy: string
    startingDeadlineSeconds: number
    successfulJobsHistoryLimit: number
    failedJobsHistoryLimit: number
    jobTemplate: { spec: { backoffLimit: number; activeDeadlineSeconds: number; template: { spec: PodSpec } } }
  }
}

const read = (filename: string) =>
  parse(readFileSync(resolve(import.meta.dir, '../../../../../argocd/applications/bayn', filename), 'utf8'))
const macroFile = 'macro-daily-sleeves-cronjob.yaml'
const scorecardFile = 'daily-scorecard-cronjob.yaml'
const macro = read(macroFile) as CronJob
const scorecard = read(scorecardFile) as CronJob
const research = read('research-worker.yaml') as { spec: { template: { spec: { containers: Container[] } } } }
const kustomization = read('kustomization.yaml') as { resources: string[] }
const pod = (job: CronJob) => job.spec.jobTemplate.spec.template.spec
const secretRefs = (container: Container) =>
  Object.fromEntries(
    container.env.flatMap(({ name, valueFrom }) =>
      valueFrom?.secretKeyRef === undefined ? [] : [[name, valueFrom.secretKeyRef]],
    ),
  )

test('Bayn jobs are registered, weekday after the SIP embargo, and use the research image alias', () => {
  for (const [filename, job, name, schedule] of [
    [macroFile, macro, 'bayn-macro-daily-sleeves', '20 20 * * 1-5'],
    [scorecardFile, scorecard, 'bayn-daily-scorecard', '35 20 * * 1-5'],
  ] as const) {
    expect(kustomization.resources).toContain(filename)
    expect(job).toMatchObject({ kind: 'CronJob', apiVersion: 'batch/v1', metadata: { name, namespace: 'bayn' } })
    expect(job.spec).toMatchObject({ schedule, timeZone: 'America/New_York', concurrencyPolicy: 'Forbid' })
    expect(pod(job)).toMatchObject({ serviceAccountName: 'bayn', automountServiceAccountToken: false })
    expect(pod(job).initContainers ?? []).toEqual([])
    for (const container of pod(job).containers) {
      expect(container.image).toBe(research.spec.template.spec.containers[0].image)
      expect(container.image).toBe('bayn-research')
      expect(container.envFrom ?? []).toEqual([])
    }
    expect(JSON.stringify(job)).not.toContain('bayn-alpaca-auth')
    expect(JSON.stringify(job)).not.toContain('bayn-db-app')
  }
})

test('each macro sleeve can only run in shadow and receives only its own account keys', () => {
  expect(macro.spec).toMatchObject({
    startingDeadlineSeconds: 1800,
    successfulJobsHistoryLimit: 5,
    failedJobsHistoryLimit: 5,
    jobTemplate: { spec: { backoffLimit: 1, activeDeadlineSeconds: 600 } },
  })
  const { containers, volumes } = pod(macro)
  expect(containers.map(({ name }) => name)).toEqual(['macro-core', 'macro-canary'])
  expect(volumes.filter(({ secret }) => secret !== undefined)).toEqual([])
  for (const [container, sleeve, entrypoint] of [
    [containers[0], 'core', 'run-macro-etf-core-rebalance'],
    [containers[1], 'canary', 'run-macro-canary-etf-rebalance'],
  ] as const) {
    const name = `bayn-alpaca-macro-${sleeve}-auth`
    const prefix = `BAYN_MACRO_${sleeve.toUpperCase()}_ALPACA`
    expect(secretRefs(container)).toEqual({
      [`${prefix}_ACCOUNT_ID`]: { name, key: 'account-id' },
      [`${prefix}_KEY_ID`]: { name, key: 'key-id' },
      [`${prefix}_SECRET_KEY`]: { name, key: 'secret-key' },
    })
    expect(container.env.some((entry) => entry.name.startsWith('BAYN_ALPACA_'))).toBe(false)
    const invocation = [...container.command, ...container.args].join(' ')
    expect(invocation).toContain(`node dist/${entrypoint}.js --mode shadow`)
    expect([...invocation.matchAll(/--mode(?:\s+|=)(\S+)/g)].map((match) => match[1])).toEqual(['shadow'])
    expect(invocation).not.toMatch(/\b(paper-submit|live)\b/)
    if (sleeve === 'core') expect(invocation).toContain('--profile F4')
    if (sleeve === 'core') expect(invocation).toContain('--exclude-symbols ""')
    expect(invocation).toContain('--capital-budget-usd 10000')
  }
})

test('scorecard is enabled with bounded job retention', () => {
  expect(scorecard.spec).toMatchObject({
    suspend: false,
    successfulJobsHistoryLimit: 3,
    failedJobsHistoryLimit: 3,
    jobTemplate: { spec: { ttlSecondsAfterFinished: 3600 } },
  })
})

test('scorecard has only the audit login, Paper account ID, TLS trust, and a read-only receipt mount', () => {
  expect(pod(scorecard).containers).toHaveLength(1)
  const [container] = pod(scorecard).containers
  expect(container.command).toEqual(['node', 'dist/bayn-daily-scorecard.js'])
  expect(container.args).toContain('--postgres')
  expect(container.env).toEqual([
    {
      name: 'BAYN_SCORECARD_POSTGRES_USERNAME',
      valueFrom: { secretKeyRef: { name: 'bayn-audit-ro-db', key: 'username' } },
    },
    {
      name: 'BAYN_SCORECARD_POSTGRES_PASSWORD',
      valueFrom: { secretKeyRef: { name: 'bayn-audit-ro-db', key: 'password' } },
    },
    { name: 'BAYN_AUDIT_ACCOUNT_ID', value: 'c0111180-21b2-4d7e-aef0-48e7abb9ad6d' },
  ])
  expect(container.volumeMounts).toContainEqual({
    name: 'postgres-ca',
    mountPath: '/var/run/secrets/bayn/postgres',
    readOnly: true,
  })
  expect(container.volumeMounts).toContainEqual({
    name: 'receipts',
    mountPath: '/tmp/bayn-macro-sleeves',
    readOnly: true,
  })
  expect(pod(scorecard).volumes.find(({ name }) => name === 'postgres-ca')?.secret).toMatchObject({
    secretName: 'bayn-db-ca',
    items: [{ key: 'ca.crt', path: 'ca.crt' }],
  })
  expect(pod(scorecard).volumes.find(({ name }) => name === 'receipts')?.persistentVolumeClaim).toEqual({
    claimName: 'bayn-macro-daily-sleeves-receipts',
    readOnly: true,
  })
})
