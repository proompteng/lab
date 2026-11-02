import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

const clusterHealth: unknown = YAML.parseDocument(
  readFileSync(join(repoRoot, 'argocd/applications/argocd/overlays/argocd-cm.yaml'), 'utf8'),
).getIn(['data', 'resource.customizations.health.postgresql.cnpg.io_Cluster'])
if (typeof clusterHealth !== 'string' || clusterHealth.length === 0) {
  throw new Error('Missing CNPG Cluster health customization')
}

const evaluate = (objectLiteral: string) => {
  const program = [
    'local function evaluate(obj)',
    clusterHealth,
    'end',
    `local health = evaluate(${objectLiteral})`,
    'io.write(health.status, "\\n", health.message or "")',
  ].join('\n')
  const result = spawnSync('lua', ['-'], { encoding: 'utf8', input: program })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  const [status, ...message] = result.stdout.trimEnd().split('\n')
  return { status, message: message.join('\n') }
}

describe('CNPG Cluster Argo CD health', () => {
  test('holds the sync wave during a major upgrade and releases it only when healthy', () => {
    expect(
      evaluate(`{ status = {
      phase = "Upgrading Postgres major version",
      phaseReason = "Upgrading cluster to major version 18",
      conditions = {{ type = "Ready", status = "False" }},
    } }`),
    ).toEqual({ status: 'Progressing', message: 'Upgrading cluster to major version 18' })
    expect(
      evaluate(`{ status = {
      phase = "Cluster in healthy state", phaseReason = "All instances ready", conditions = {},
    } }`),
    ).toEqual({ status: 'Healthy', message: 'All instances ready' })
  })

  test.each([
    'Cluster upgrade delayed',
    'Waiting for user action',
    'Failing over',
    'Cluster cannot execute instance online upgrade due to missing architecture binary',
  ])('preserves degraded state and operator context for %s', (phase) => {
    expect(
      evaluate(`{ status = { phase = "${phase}", phaseReason = "Operator intervention needed", conditions = {} } }`),
    ).toEqual({ status: 'Degraded', message: 'Operator intervention needed' })
  })

  test.each([
    'Unable to create required cluster objects',
    'Cluster has incomplete or invalid image catalog',
    'Cluster is unrecoverable and needs manual intervention',
  ])('preserves suspended state for %s', (phase) => {
    expect(evaluate(`{ status = { phase = "${phase}", conditions = {} } }`).status).toBe('Suspended')
  })

  test('prioritizes explicit suspension and hibernation over upgrade progress', () => {
    expect(evaluate('{ metadata = { annotations = { ["cnpg.io/reconciliationLoop"] = "disabled" } } }').status).toBe(
      'Suspended',
    )
    for (const [condition, expected] of [
      ['True', 'Suspended'],
      ['False', 'Degraded'],
    ]) {
      expect(
        evaluate(`{ status = { phase = "Upgrading Postgres major version", conditions = {
        { type = "cnpg.io/hibernation", status = "${condition}", message = "Hibernation state" }
      } } }`),
      ).toEqual({ status: expected, message: 'Hibernation state' })
    }
  })

  test('does not report missing or unknown operator status as healthy', () => {
    expect(evaluate('{}').status).toBe('Progressing')
    expect(evaluate('{ status = { phase = "New operator phase", conditions = {} } }').status).toBe('Unknown')
  })
})
