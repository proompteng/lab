import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type ArgoConfigMap = {
  readonly data?: Readonly<Record<string, string>>
}

type HealthStatus = {
  readonly message: string
  readonly status: string
}

const argoConfigMap = YAML.parse(
  readFileSync(join(repoRoot, 'argocd/applications/argocd/overlays/argocd-cm.yaml'), 'utf8'),
) as ArgoConfigMap
const backupHealth = argoConfigMap.data?.['resource.customizations.health.postgresql.cnpg.io_Backup'] ?? ''

const evaluateBackupHealth = (objectLiteral: string): HealthStatus => {
  const program = [
    'local function evaluate(obj)',
    backupHealth,
    'end',
    `local health = evaluate(${objectLiteral})`,
    'io.write(health.status, "\\n", health.message)',
  ].join('\n')
  const result = spawnSync('lua', ['-'], { encoding: 'utf8', input: program })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')

  const [status, ...messageParts] = result.stdout.trimEnd().split('\n')
  return { message: messageParts.join('\n'), status: status ?? '' }
}

describe('CNPG Backup Argo CD health customization', () => {
  test('is configured for the CNPG Backup resource', () => {
    expect(backupHealth).toContain('phase == "completed"')
    expect(backupHealth).toContain('phase == "failed"')
    expect(backupHealth).toContain('status.stoppedAt')
  })

  test('reports completed backups healthy only with a stoppedAt timestamp', () => {
    expect(
      evaluateBackupHealth(`{
        status = { phase = "completed", stoppedAt = "2026-09-07T12:00:00Z" },
      }`),
    ).toEqual({
      message: 'CNPG Backup completed at 2026-09-07T12:00:00Z.',
      status: 'Healthy',
    })

    expect(evaluateBackupHealth('{ status = { phase = "completed" } }')).toEqual({
      message: 'CNPG Backup phase: completed.',
      status: 'Progressing',
    })
  })

  test('reports failed backups degraded with operator error context', () => {
    expect(
      evaluateBackupHealth(`{
        status = { phase = "failed", error = "snapshot timed out" },
      }`),
    ).toEqual({ message: 'snapshot timed out', status: 'Degraded' })

    expect(evaluateBackupHealth('{ status = { phase = "failed" } }')).toEqual({
      message: 'CNPG Backup failed.',
      status: 'Degraded',
    })
  })

  test('keeps missing and in-progress status progressing', () => {
    expect(evaluateBackupHealth('{}')).toEqual({
      message: 'Waiting for CNPG Backup status.',
      status: 'Progressing',
    })
    expect(evaluateBackupHealth('{ status = { phase = "running" } }')).toEqual({
      message: 'CNPG Backup phase: running.',
      status: 'Progressing',
    })
  })
})
