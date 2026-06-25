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
