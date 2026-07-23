import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

interface MimirRule {
  readonly alert: string
  readonly expr: string
  readonly for: string
}

const baynRules = (): readonly MimirRule[] => {
  const configMap = YAML.parse(readRepoFile('argocd/applications/observability/graf-mimir-rules.yaml')) as Record<
    string,
    any
  >
  const rules = YAML.parse(configMap.data['graf-rules.yaml']) as {
    groups: readonly { readonly name: string; readonly rules: readonly MimirRule[] }[]
  }
  const group = rules.groups.find(({ name }) => name === 'bayn-cycle-operations.rules')
  if (group === undefined) throw new Error('Bayn cycle operations rule group is missing')
  return group.rules
}

describe('Bayn cycle operations contract', () => {
  test('keeps autonomous broker observation explicitly bounded to OBSERVE authority', () => {
    const deployment = YAML.parse(readRepoFile('argocd/applications/bayn/deployment.yaml')) as Record<string, any>
    const container = deployment.spec.template.spec.containers.find(
      ({ name }: { readonly name: string }) => name === 'bayn',
    )
    const environment = Object.fromEntries(container.env.map((entry: { readonly name: string }) => [entry.name, entry]))
    const generationHash = createHash('sha256').update('bayn/authority-generation/autonomous-observe-v1').digest('hex')

    expect(environment.BAYN_MAXIMUM_AUTHORITY).toEqual({
      name: 'BAYN_MAXIMUM_AUTHORITY',
      value: 'OBSERVE',
    })
    expect(environment.BAYN_AUTHORITY_GENERATION_HASH).toEqual({
      name: 'BAYN_AUTHORITY_GENERATION_HASH',
      value: generationHash,
    })
    expect(environment.BAYN_CYCLE_POLL_INTERVAL_MS).toEqual({
      name: 'BAYN_CYCLE_POLL_INTERVAL_MS',
      value: '30000',
    })
    expect(environment.BAYN_ALPACA_ACCOUNT_ID.valueFrom.secretKeyRef).toEqual({
      name: 'bayn-alpaca-auth',
      key: 'account-id',
    })
    expect(environment.BAYN_ALPACA_KEY_ID.valueFrom.secretKeyRef).toEqual({
      name: 'bayn-alpaca-auth',
      key: 'key-id',
    })
    expect(environment.BAYN_ALPACA_SECRET_KEY.valueFrom.secretKeyRef).toEqual({
      name: 'bayn-alpaca-auth',
      key: 'secret-key',
    })
  })

  test('alerts only on scrape health and canonical service conditions', () => {
    const rules = baynRules()
    expect(rules.map(({ alert }) => alert)).toEqual([
      'BaynMetricsUnavailable',
      'BaynCycleObservationUnavailable',
      'BaynCycleStalled',
      'BaynCycleFailed',
    ])
    expect(rules.every((rule) => rule.for === '1m' || rule.for === '2m')).toBe(true)

    const expressions = Object.fromEntries(rules.map((rule) => [rule.alert, rule.expr]))
    expect(expressions.BaynMetricsUnavailable).toContain('up{')
    expect(expressions.BaynCycleObservationUnavailable).toContain('bayn_cycle_observation_available')
    expect(expressions.BaynCycleStalled).toContain('condition="stalled"')
    expect(expressions.BaynCycleFailed).toContain('condition="failed"')
    expect(rules.map(({ expr }) => expr).join('\n')).not.toMatch(
      /cycle_id|account_id|decision_hash|mutation_id|bayn_authority_|bayn_broker_|bayn_reconciliation_|bayn_unresolved_/,
    )
  })

  test('scrapes only bounded Bayn metrics through the existing cluster collector', () => {
    const rules = baynRules()
    const alloy = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
    const deployment = YAML.parse(
      readRepoFile('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml'),
    ) as Record<string, any>
    const digest = createHash('sha256').update(alloy).digest('hex')

    expect(alloy).toContain('discovery.kubernetes "bayn_pods"')
    expect(alloy).toContain('label = "app.kubernetes.io/name=bayn"')
    expect(alloy).toContain('targets         = discovery.relabel.bayn_metrics.output')
    expect(alloy).not.toContain('__meta_kubernetes_pod_ready')
    expect(alloy).toContain('regex         = "up|bayn_.*"')
    expect(deployment.spec.template.metadata.annotations['observability.proompteng.ai/config-sha256']).toBe(digest)

    const policies = YAML.parseAllDocuments(readRepoFile('argocd/applications/bayn/networkpolicy.yaml')).map(
      (document) => document.toJSON() as Record<string, any>,
    )
    const bayn = policies.find((policy) => policy.metadata?.name === 'bayn')
    expect(bayn?.spec.ingress).toContainEqual({
      from: [
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': 'observability' },
          },
          podSelector: {
            matchLabels: { 'app.kubernetes.io/name': 'observability-cluster-metrics-alloy' },
          },
        },
      ],
      ports: [{ port: 'http', protocol: 'TCP' }],
    })

    const dashboardConfigMap = YAML.parse(
      readRepoFile('argocd/applications/observability/bayn-cycle-operations-dashboard-configmap.yaml'),
    ) as Record<string, any>
    const dashboard = JSON.parse(dashboardConfigMap.data['bayn-cycle-operations-dashboard.json']) as {
      readonly uid: string
      readonly panels: readonly { readonly targets?: readonly { readonly expr?: string }[] }[]
    }
    const dashboardExpressions = dashboard.panels.flatMap(({ targets = [] }) =>
      targets.flatMap(({ expr }) => (expr === undefined ? [] : [expr])),
    )
    const kustomization = readRepoFile('argocd/applications/observability/kustomization.yaml')
    const grafanaValues = readRepoFile('argocd/applications/observability/grafana-values.yaml')

    expect(dashboard.uid).toBe('bayn-cycle-operations')
    expect(kustomization).toContain('bayn-cycle-operations-dashboard-configmap.yaml')
    expect(grafanaValues).toContain('bayn-cycle-operations-dashboard: bayn-cycle-operations-dashboard')
    expect([...rules.map(({ expr }) => expr), ...dashboardExpressions].join('\n')).not.toMatch(
      /cycle_id|account_id|decision_hash|mutation_id|client_order_id/,
    )
  })
})
