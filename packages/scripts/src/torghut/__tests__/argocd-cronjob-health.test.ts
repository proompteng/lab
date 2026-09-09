import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type ArgoConfigMap = {
  data?: Record<string, string>
}

const argoConfigMap = YAML.parse(
  readFileSync(join(repoRoot, 'argocd/applications/argocd/overlays/argocd-cm.yaml'), 'utf8'),
) as ArgoConfigMap

const cronJobHealth = argoConfigMap.data?.['resource.customizations.health.batch_CronJob'] ?? ''
const sealedSecretHealth = argoConfigMap.data?.['resource.customizations.health.bitnami.com_SealedSecret'] ?? ''

type HealthStatus = {
  readonly message: string
  readonly status: string
}

const evaluateSealedSecretHealth = (objectLiteral: string): HealthStatus => {
  const program = [
    'local function evaluate(obj)',
    sealedSecretHealth,
    'end',
    `local health = evaluate(${objectLiteral})`,
    'io.write(health.status, "\\n", health.message)',
  ].join('\n')
  const result = spawnSync('lua', ['-'], {
    encoding: 'utf8',
    input: program,
  })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')

  const [status, ...messageParts] = result.stdout.trimEnd().split('\n')
  return {
    message: messageParts.join('\n'),
    status: status ?? '',
  }
}

describe('Argo CD SealedSecret health customization', () => {
  it('preserves the legacy healthy result for resources that do not opt in', () => {
    expect(evaluateSealedSecretHealth('{ metadata = {} }')).toEqual({
      message: 'SealedSecret health is ignored; decryption is handled by the sealed-secrets controller.',
      status: 'Healthy',
    })
  })

  it('waits when the controller has not observed the opted-in generation', () => {
    expect(
      evaluateSealedSecretHealth(`{
        metadata = {
          annotations = { ["argocd.proompteng.ai/wait-for-sealed-secret"] = "true" },
          generation = 4,
        },
        status = { observedGeneration = 3 },
      }`),
    ).toEqual({
      message: 'Waiting for the sealed-secrets controller to observe the current generation.',
      status: 'Progressing',
    })
  })

  it('degrades an opted-in current generation rejected by the controller', () => {
    expect(
      evaluateSealedSecretHealth(`{
        metadata = {
          annotations = { ["argocd.proompteng.ai/wait-for-sealed-secret"] = "true" },
          generation = 4,
        },
        status = {
          observedGeneration = 4,
          conditions = { { type = "Synced", status = "False", message = "decryption failed" } },
        },
      }`),
    ).toEqual({
      message: 'decryption failed',
      status: 'Degraded',
    })
  })

  it('becomes healthy only after the controller syncs the opted-in current generation', () => {
    expect(
      evaluateSealedSecretHealth(`{
        metadata = {
          annotations = { ["argocd.proompteng.ai/wait-for-sealed-secret"] = "true" },
          generation = 4,
        },
        status = {
          observedGeneration = 4,
          conditions = { { type = "Synced", status = "True" } },
        },
      }`),
    ).toEqual({
      message: 'The sealed-secrets controller produced the current Secret generation.',
      status: 'Healthy',
    })
  })
})

describe('Argo CD CronJob health customization', () => {
  it('keeps stale Torghut scheduled-job history from blocking app promotion sync', () => {
    expect(cronJobHealth).toContain('metadata.namespace == "torghut"')
    expect(cronJobHealth).toContain('labels["app.kubernetes.io/name"] == "torghut"')
    expect(cronJobHealth).toContain('scheduled job results are monitored outside Argo app health')
    expect(cronJobHealth).not.toContain('torghut-paper-account-flatten')
  })

  it('checks Torghut CronJobs before the generic suspended CronJob health branch', () => {
    expect(cronJobHealth.indexOf('metadata.namespace == "torghut"')).toBeGreaterThanOrEqual(0)
    expect(cronJobHealth.indexOf('if spec.suspend == true then')).toBeGreaterThanOrEqual(0)
    expect(cronJobHealth.indexOf('metadata.namespace == "torghut"')).toBeLessThan(
      cronJobHealth.indexOf('if spec.suspend == true then'),
    )
  })

  it('retains failed-run health for non-Torghut CronJobs', () => {
    expect(cronJobHealth).toContain('status.lastScheduleTime ~= nil and status.lastSuccessfulTime == nil')
    expect(cronJobHealth).toContain('status.lastScheduleTime > status.lastSuccessfulTime')
    expect(cronJobHealth).toContain('CronJob has not completed its last execution successfully.')
  })
})
