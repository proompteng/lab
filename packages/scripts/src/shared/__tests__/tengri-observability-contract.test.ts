import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

interface MimirRule {
  readonly alert?: string
  readonly record?: string
  readonly expr: string
  readonly for?: string
  readonly annotations?: Readonly<Record<string, string>>
}

const tengriRules = (): readonly MimirRule[] => {
  const configMap = YAML.parse(readRepoFile('argocd/applications/observability/graf-mimir-rules.yaml')) as Record<
    string,
    any
  >
  const rules = YAML.parse(configMap.data['graf-rules.yaml']) as {
    groups: readonly { readonly name: string; readonly rules: readonly MimirRule[] }[]
  }
  const group = rules.groups.find(({ name }) => name === 'tengri-production.rules')
  if (group === undefined) throw new Error('Tengri production rule group is missing')
  return group.rules
}

test('cluster Alloy collects bounded Tengri control-plane and supervisor metrics', () => {
  const alloy = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const deployment = YAML.parse(
    readRepoFile('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml'),
  ) as Record<string, any>
  const policies = YAML.parseAllDocuments(readRepoFile('argocd/applications/tengri/network-policies.yaml')).map(
    (document) => document.toJSON() as Record<string, any>,
  )

  expect(alloy).toContain('prometheus.scrape "tengri"')
  expect(alloy).toContain('tengri-gateway.tengri.svc.cluster.local:8080')
  expect(alloy).toContain('job_name = "tengri"')
  expect(alloy).toContain('discovery.kubernetes "tengri_slots"')
  expect(alloy).toContain('app.kubernetes.io/name=tengri-slot')
  expect(alloy).toContain('regex         = "supervisor;health"')
  expect(alloy).toContain('job_name        = "tengri-slot-supervisor"')
  expect(alloy).toContain('regex         = "up|tengri_.*"')
  expect(alloy).toContain('forward_to      = [prometheus.relabel.tengri_metrics.receiver]')
  expect(alloy).toContain('|kube_pod_status_ready|')
  expect(alloy).not.toMatch(/owner_hash|agent_id|terminal_id|session_id/)
  expect(deployment.spec.template.metadata.annotations['observability.proompteng.ai/config-sha256']).toBe(
    createHash('sha256').update(alloy).digest('hex'),
  )

  const controlPlanePolicy = policies.find(
    (policy) => policy.kind === 'NetworkPolicy' && policy.metadata?.name === 'tengri-control-plane',
  )
  expect(controlPlanePolicy?.spec.ingress).toContainEqual({
    from: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'observability' },
        },
      },
    ],
    ports: [{ protocol: 'TCP', port: 8080 }],
  })
  const slotPolicy = policies.find(
    (policy) => policy.kind === 'NetworkPolicy' && policy.metadata?.name === 'tengri-slots',
  )
  expect(slotPolicy?.spec.ingress).toContainEqual({
    from: [
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'observability' } },
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'observability-cluster-metrics-alloy' } },
      },
    ],
    ports: [{ protocol: 'TCP', port: 8080 }],
  })
})

test('Mimir alerts on Tengri availability, failed guests, latency, and quota pressure', () => {
  const rules = tengriRules()

  expect(rules.map(({ record, alert }) => record ?? alert)).toEqual([
    'tengri_rollout_enabled',
    'TengriArgoApplicationDegraded',
    'TengriMetricsUnavailable',
    'TengriSlotPodsMissing',
    'TengriSlotPoolUnavailable',
    'TengriAgentFailed',
    'TengriGuestFailureBurst',
    'TengriBootLatencyHigh',
    'TengriResumeLatencyHigh',
    'TengriTerminalHeartbeatLatencyHigh',
    'TengriGuestConnectLatencyHigh',
    'TengriQuotaRejections',
  ])

  const alerts = rules.filter((rule) => rule.alert !== undefined)
  expect(alerts.every((rule) => rule.for === '5m')).toBe(true)
  expect(alerts.every((rule) => rule.annotations?.runbook_url === 'docs/tengri/operations.md')).toBe(true)

  const expressions = Object.fromEntries(alerts.map((rule) => [rule.alert, rule.expr]))
  expect(expressions.TengriArgoApplicationDegraded).toContain('argocd_app_info')
  expect(expressions.TengriMetricsUnavailable).toContain('tengri_rollout_enabled == 1')
  expect(expressions.TengriSlotPodsMissing).toContain('kube_pod_info')
  expect(expressions.TengriSlotPoolUnavailable).toContain('kube_pod_status_ready')
  expect(expressions.TengriAgentFailed).toContain('state="failed"')
  expect(expressions.TengriGuestFailureBurst).toContain('tengri_guest_failures_total')
  expect(expressions.TengriBootLatencyHigh).toContain('tengri_agent_boot_latency_seconds_count')
  expect(expressions.TengriResumeLatencyHigh).toContain('tengri_agent_resume_latency_seconds_count')
  expect(expressions.TengriTerminalHeartbeatLatencyHigh).toContain('tengri_terminal_heartbeat_seconds_bucket')
  expect(expressions.TengriGuestConnectLatencyHigh).toContain('tengri_guest_connect_seconds_bucket')
  expect(expressions.TengriQuotaRejections).toContain('tengri_quota_rejections_total')
  expect(alerts.map(({ expr }) => expr).join('\n')).not.toMatch(/owner_hash|agent_id|terminal_id|session_id/)
})
