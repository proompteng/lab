import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
const externalSecretHealth =
  argoConfigMap.data?.['resource.customizations.health.external-secrets.io_ExternalSecret'] ?? ''

describe('Argo CD CronJob health customization', () => {
  it('keeps stale Torghut scheduled-job history from blocking app promotion sync', () => {
    expect(cronJobHealth).toContain('metadata.namespace == "torghut"')
    expect(cronJobHealth).toContain('labels["app.kubernetes.io/name"] == "torghut"')
    expect(cronJobHealth).toContain('scheduled job results are monitored outside Argo app health')
    expect(cronJobHealth).not.toContain('torghut-paper-account-flatten')
  })

  it('retains failed-run health for non-Torghut CronJobs', () => {
    expect(cronJobHealth).toContain('status.lastScheduleTime ~= nil and status.lastSuccessfulTime == nil')
    expect(cronJobHealth).toContain('status.lastScheduleTime > status.lastSuccessfulTime')
    expect(cronJobHealth).toContain('CronJob has not completed its last execution successfully.')
  })
})

describe('Argo CD ExternalSecret health customization', () => {
  it('keeps created-once synced secrets healthy without periodic provider reads', () => {
    expect(externalSecretHealth).toContain('spec.refreshPolicy == "CreatedOnce"')
    expect(externalSecretHealth).toContain('bindingName ~= ""')
    expect(externalSecretHealth).toContain('syncedResourceVersion ~= ""')
    expect(externalSecretHealth).toContain('Created-once ExternalSecret has already created its target Secret.')
  })

  it('keeps provider failures degraded for normal ExternalSecrets', () => {
    expect(externalSecretHealth).toContain('condition.type == "Ready"')
    expect(externalSecretHealth).toContain('condition.status == "False"')
    expect(externalSecretHealth).toContain('hs.status = "Degraded"')
  })
})
