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
const externalSecretHealth =
  argoConfigMap.data?.['resource.customizations.health.external-secrets.io_ExternalSecret'] ?? ''

const evaluateExternalSecretHealth = (objectLiteral: string): HealthStatus => {
  const program = [
    'local function evaluate(obj)',
    externalSecretHealth,
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

describe('ExternalSecret Argo CD health customization', () => {
  test('is configured for external-secrets.io/ExternalSecret', () => {
    expect(externalSecretHealth).toContain('argocd.argoproj.io/ignore-healthcheck')
    expect(externalSecretHealth).toContain('condition.type == "Ready"')
  })

  test('reports optional ExternalSecrets healthy when ignore-healthcheck=true even on SecretSyncedError', () => {
    expect(
      evaluateExternalSecretHealth(`{
        metadata = {
          annotations = {
            ["argocd.argoproj.io/ignore-healthcheck"] = "true",
          },
        },
        status = {
          conditions = {
            {
              type = "Ready",
              status = "False",
              reason = "SecretSyncedError",
              message = "could not get secret data from provider",
            },
          },
        },
      }`),
    ).toEqual({
      message: 'Optional ExternalSecret health check ignored by annotation.',
      status: 'Healthy',
    })
  })

  test('preserves standard Healthy/Degraded/Progressing semantics without ignore-healthcheck', () => {
    expect(
      evaluateExternalSecretHealth(`{
        status = {
          conditions = {
            { type = "Ready", status = "True", reason = "SecretSynced", message = "Secret was synced" },
          },
        },
      }`),
    ).toEqual({
      message: 'Secret was synced',
      status: 'Healthy',
    })

    expect(
      evaluateExternalSecretHealth(`{
        status = {
          conditions = {
            {
              type = "Ready",
              status = "False",
              reason = "SecretSyncedError",
              message = "could not get secret data from provider",
            },
          },
        },
      }`),
    ).toEqual({
      message: 'could not get secret data from provider',
      status: 'Degraded',
    })

    expect(evaluateExternalSecretHealth('{}')).toEqual({
      message: 'Waiting for ExternalSecret to sync.',
      status: 'Progressing',
    })
  })
})
