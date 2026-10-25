import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

test('retained Cassandra data can open before steady-state liveness is enabled', () => {
  const source = YAML.parse(
    readFileSync(new URL('../../../../../argocd/applications/temporal/kustomization.yaml', import.meta.url), 'utf8'),
  )
  const cassandra = source.patches.find(
    (patch: { target?: { name?: string } }) => patch.target?.name === 'temporal-cassandra',
  )
  const operations = YAML.parse(cassandra.patch)
  const startup = operations.find(
    (operation: { path: string }) => operation.path === '/spec/template/spec/containers/0/startupProbe',
  )?.value

  expect(startup).toBeDefined()
  expect(startup.exec.command).toEqual(['/bin/sh', '-c', 'nodetool status'])
  expect(startup.periodSeconds * startup.failureThreshold).toBeGreaterThanOrEqual(900)
  expect(startup.periodSeconds * startup.failureThreshold).toBeLessThanOrEqual(1800)
  expect(startup.timeoutSeconds).toBeGreaterThan(0)
  expect(operations.some((operation: { path: string }) => operation.path.includes('livenessProbe'))).toBe(false)
  expect(operations.some((operation: { path: string }) => operation.path.includes('readinessProbe'))).toBe(false)
})
