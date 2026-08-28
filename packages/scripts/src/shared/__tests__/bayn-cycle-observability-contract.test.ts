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

describe('Bayn cycle operations alert contract', () => {
  test('alerts only on scrape health, bounded runtime readiness, and canonical cycle conditions', () => {
    const rules = baynRules()
    expect(rules.map(({ alert }) => alert)).toEqual([
      'BaynMetricsUnavailable',
      'BaynStatusReplicaTargetMissed',
      'BaynEgressProxyReplicaTargetMissed',
      'BaynExecutionWorkerUnavailable',
      'BaynExecutionWorkerReplicaTargetMissed',
      'BaynExecutionControllerOverdue',
      'BaynExecutionSessionAdmissionMissed',
      'BaynExecutionWindowUnready',
      'BaynExecutionDecisionLagging',
      'BaynCycleObservationUnavailable',
      'BaynRuntimeDegraded',
      'BaynCycleStalled',
      'BaynCycleFailed',
    ])
    expect(rules.every((rule) => rule.for === '1m' || rule.for === '2m')).toBe(true)

    const expressions = Object.fromEntries(rules.map((rule) => [rule.alert, rule.expr]))
    expect(expressions.BaynMetricsUnavailable).toContain('up{')
    expect(expressions.BaynStatusReplicaTargetMissed).toMatch(
      /kube_deployment_status_replicas_available\{[^}]*namespace="bayn"[^}]*deployment="bayn"/s,
    )
    expect(expressions.BaynStatusReplicaTargetMissed).toContain('kube_deployment_spec_replicas{')
    expect(expressions.BaynEgressProxyReplicaTargetMissed).toContain('deployment="bayn-egress-proxy"')
    expect(expressions.BaynExecutionWorkerUnavailable).toContain('kube_replicaset_status_ready_replicas{')
    expect(expressions.BaynExecutionWorkerUnavailable).toContain('replicaset=~"bayn-execution-controller-.*"')
    expect(expressions.BaynExecutionWorkerUnavailable).toContain('kube_restate_deployment_spec_replicas{')
    expect(expressions.BaynExecutionWorkerUnavailable).toContain('restate_deployment="bayn-execution-controller"')
    expect(expressions.BaynExecutionWorkerReplicaTargetMissed).toContain('kube_restate_deployment_spec_replicas{')
    expect(expressions.BaynExecutionWorkerReplicaTargetMissed).toContain('> 1')
    expect(expressions.BaynExecutionControllerOverdue).toContain('bayn_execution_controller_active{')
    expect(expressions.BaynExecutionControllerOverdue).toContain(
      'bayn_execution_controller_next_due_timestamp_seconds{',
    )
    expect(expressions.BaynExecutionControllerOverdue).toContain('bayn_cycle_stall_threshold_seconds{')
    expect(expressions.BaynExecutionSessionAdmissionMissed).toContain('bayn_autonomous_cycle_not_due_reason{')
    expect(expressions.BaynExecutionSessionAdmissionMissed).toContain('reason="stale_capital_bootstrap"')
    expect(expressions.BaynExecutionSessionAdmissionMissed).toContain('bayn_capital_activation_state{')
    expect(expressions.BaynExecutionSessionAdmissionMissed).toContain('state="realized"')
    expect(expressions.BaynExecutionWindowUnready).toContain('bayn_execution_session_preflight_ready{')
    expect(expressions.BaynExecutionWindowUnready).toContain('bayn_cycle_decision_bound{')
    expect(expressions.BaynExecutionWindowUnready).toContain('bayn_cycle_submission_open_timestamp_seconds{')
    expect(expressions.BaynExecutionWindowUnready).toContain('bayn_cycle_submission_cutoff_timestamp_seconds{')
    expect(expressions.BaynExecutionWindowUnready).toContain('- 600')
    expect(expressions.BaynExecutionDecisionLagging).toContain('bayn_execution_session_preflight_ready{')
    expect(expressions.BaynExecutionDecisionLagging).toContain('bayn_cycle_decision_bound{')
    expect(expressions.BaynExecutionDecisionLagging).toContain('bayn_cycle_submission_open_timestamp_seconds{')
    expect(expressions.BaynExecutionDecisionLagging).toContain('bayn_cycle_submission_cutoff_timestamp_seconds{')
    expect(expressions.BaynExecutionDecisionLagging).toContain('+ 120')
    expect(expressions.BaynCycleObservationUnavailable).toContain('bayn_cycle_observation_available')
    expect(expressions.BaynCycleObservationUnavailable).not.toContain('absent(')
    expect(expressions.BaynRuntimeDegraded).toContain('bayn_runtime_ready')
    expect(expressions.BaynRuntimeDegraded).toMatch(/bayn_cycle_observation_available\{[^}]+\} == 1/s)
    expect(expressions.BaynRuntimeDegraded).toMatch(/condition="stalled"\s*\} == 0/)
    expect(expressions.BaynRuntimeDegraded).toMatch(/condition="failed"\s*\} == 0/)
    expect(expressions.BaynRuntimeDegraded.match(/and on\(job, namespace, service, instance\)/g)).toHaveLength(3)
    expect(expressions.BaynCycleStalled).toContain('condition="stalled"')
    expect(expressions.BaynCycleFailed).toContain('condition="failed"')
    expect(rules.map(({ expr }) => expr).join('\n')).not.toMatch(
      /cycle_id|account_id|decision_hash|mutation_id|bayn_authority_|bayn_broker_|bayn_reconciliation_|bayn_unresolved_/,
    )
  })

  test('collects bounded Bayn metrics and trace-correlated logs through the existing cluster collector', () => {
    const rules = baynRules()
    const alloy = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
    const kubeStateMetricsSource = readRepoFile('argocd/applications/observability/kube-state-metrics-values.yaml')
    const kubeStateMetrics = YAML.parse(kubeStateMetricsSource) as { readonly collectors: readonly string[] }
    const grafanaConfiguration = YAML.parse(
      readRepoFile('argocd/applications/observability/grafana-values.yaml'),
    ) as Record<string, any>
    const deployment = YAML.parse(
      readRepoFile('argocd/applications/observability/cluster-metrics-alloy-deployment.yaml'),
    ) as Record<string, any>
    const digest = createHash('sha256').update(alloy).digest('hex')

    expect(alloy).toContain('discovery.kubernetes "bayn_pods"')
    expect(alloy).toContain('label = "app.kubernetes.io/name=bayn"')
    expect(alloy).toContain('targets         = discovery.relabel.bayn_metrics.output')
    expect(alloy).not.toContain('__meta_kubernetes_pod_ready')
    expect(alloy).toContain('regex         = "up|bayn_.*"')
    expect(alloy).toContain('kube_replicaset_spec_replicas')
    expect(alloy).toContain('kube_replicaset_status_ready_replicas')
    expect(alloy).toContain('kube_restate_deployment_spec_replicas')
    expect(kubeStateMetrics.collectors).toContain('replicasets')
    expect(kubeStateMetricsSource).toContain('kind: RestateDeployment')
    expect(kubeStateMetricsSource).toContain('name: deployment_spec_replicas')
    expect(alloy).toContain('discovery.kubernetes "bayn_log_pods"')
    expect(alloy).toContain('label = "app.kubernetes.io/part-of=bayn"')
    const baynContainerKeepRule =
      /source_labels = \["__meta_kubernetes_pod_container_name"\]\s+regex\s+=\s+"([^"]+)"/s.exec(alloy)?.[1]
    if (baynContainerKeepRule === undefined) throw new Error('Bayn container log keep rule is missing')
    const retainedBaynContainer = new RegExp(`^(?:${baynContainerKeepRule})$`)
    expect(
      ['bayn', 'execution-controller', 'activate'].filter((container) => retainedBaynContainer.test(container)),
    ).toEqual(['bayn', 'execution-controller', 'activate'])
    expect(
      ['lifecycle', 'register', 'egress-proxy'].filter((container) => retainedBaynContainer.test(container)),
    ).toEqual([])
    expect(alloy).toContain('loki.source.kubernetes "bayn_pod_logs"')
    expect(alloy).toContain('forward_to = [loki.write.bayn.receiver]')
    expect(alloy).not.toMatch(/trace_id|span_id/)
    expect(alloy).toContain(
      'url = "http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/push"',
    )
    expect(deployment.spec.template.metadata.annotations['observability.proompteng.ai/config-sha256']).toBe(digest)

    const datasources = grafanaConfiguration.datasources['datasources.yaml'].datasources as ReadonlyArray<
      Record<string, any>
    >
    const lokiDatasource = datasources.find((datasource) => datasource.uid === 'loki')
    const tempoDatasource = datasources.find((datasource) => datasource.uid === 'tempo')
    expect(lokiDatasource?.jsonData.derivedFields).toEqual([
      {
        datasourceUid: 'tempo',
        matcherRegex: '"trace_id"\\s*:\\s*"([0-9a-f]{32})"',
        name: 'TraceID',
        url: '$${__value.raw}',
        urlDisplayLabel: 'View trace',
      },
    ])
    expect(
      new RegExp(lokiDatasource?.jsonData.derivedFields[0].matcherRegex).exec(
        '{"trace_id":"0123456789abcdef0123456789abcdef"}',
      )?.[1],
    ).toBe('0123456789abcdef0123456789abcdef')
    expect(tempoDatasource?.jsonData.tracesToLogsV2).toEqual({
      datasourceUid: 'loki',
      spanStartTimeShift: '-5s',
      spanEndTimeShift: '5s',
      tags: [
        { key: 'service.name', value: 'service' },
        { key: 'k8s.namespace.name', value: 'namespace' },
      ],
      filterByTraceID: false,
      filterBySpanID: false,
      customQuery: true,
      query: '{$${__tags}} |= "$${__trace.traceId}"',
    })

    const collectorRbac = YAML.parseAllDocuments(
      readRepoFile('argocd/applications/observability/cluster-metrics-alloy-rbac.yaml'),
    ).map((document) => document.toJSON() as Record<string, any>)
    const baynLogRole = collectorRbac.find(
      (resource) => resource.kind === 'Role' && resource.metadata?.name === 'observability-bayn-log-reader',
    )
    const baynLogBinding = collectorRbac.find(
      (resource) => resource.kind === 'RoleBinding' && resource.metadata?.name === 'observability-bayn-log-reader',
    )
    expect(baynLogRole).toMatchObject({
      metadata: { namespace: 'bayn' },
      rules: [{ apiGroups: [''], resources: ['pods/log'], verbs: ['get'] }],
    })
    expect(baynLogBinding).toMatchObject({
      metadata: { namespace: 'bayn' },
      roleRef: { kind: 'Role', name: 'observability-bayn-log-reader' },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: 'observability-cluster-metrics-alloy',
          namespace: 'observability',
        },
      ],
    })

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
      readonly description: string
      readonly title: string
      readonly uid: string
      readonly version: number
      readonly time: { readonly from: string; readonly to: string }
      readonly panels: readonly {
        readonly description?: string
        readonly gridPos: {
          readonly h: number
          readonly w: number
          readonly x: number
          readonly y: number
        }
        readonly title: string
        readonly type: string
        readonly targets?: readonly {
          readonly expr?: string
          readonly instant?: boolean
          readonly range?: boolean
        }[]
        readonly fieldConfig?: Record<string, any>
        readonly options?: Record<string, any>
      }[]
    }
    const dashboardExpressions = dashboard.panels.flatMap(({ targets = [] }) =>
      targets.flatMap(({ expr }) => (expr === undefined ? [] : [expr])),
    )
    const kustomization = readRepoFile('argocd/applications/observability/kustomization.yaml')
    const grafanaValues = readRepoFile('argocd/applications/observability/grafana-values.yaml')

    expect(dashboard.uid).toBe('bayn-cycle-operations')
    expect(dashboard.title).toBe('Bayn Trading Operations')
    expect(dashboard.version).toBe(3)
    expect(dashboard.time).toEqual({ from: 'now-24h', to: 'now' })
    expect(dashboard.description).toContain('zero orders are explained by the first stage that did not advance')
    expect(dashboard.panels.map(({ title }) => title)).toEqual([
      'Runtime',
      'Execution controller',
      'Broker binding',
      'Ledger safety',
      'Execution authority',
      'Cycle condition',
      'Current blocker',
      'Cycle phase',
      'Session preflight',
      'Snapshot',
      'Decision',
      'Target plan',
      'Targets',
      'Intents',
      'Orders',
      'Fills',
      'Opportunity → fill',
      'Bound market data',
      'Session window',
      'Open positions',
      'Gross exposure',
      'Net exposure',
      'Buying power',
      'Unrealized P&L',
      'Unresolved mutations',
      'Gross realized P&L',
      'Recorded costs',
      'Net realized P&L',
      'Profitability',
      'Accounting coverage',
      'Opportunity → fill history',
      'Blocker history',
      'Execution latency',
      'Safety freshness',
      'Running build',
    ])
    expect(new Set(dashboard.panels.map(({ title }) => title)).size).toBe(dashboard.panels.length)
    const overlappingPanels = dashboard.panels.flatMap((left, leftIndex) =>
      dashboard.panels.slice(leftIndex + 1).flatMap((right) => {
        const overlapsHorizontally =
          left.gridPos.x < right.gridPos.x + right.gridPos.w && right.gridPos.x < left.gridPos.x + left.gridPos.w
        const overlapsVertically =
          left.gridPos.y < right.gridPos.y + right.gridPos.h && right.gridPos.y < left.gridPos.y + left.gridPos.h
        return overlapsHorizontally && overlapsVertically ? [`${left.title} / ${right.title}`] : []
      }),
    )
    expect(overlappingPanels).toEqual([])
    expect(dashboardExpressions).toEqual(
      expect.arrayContaining([
        'min(bayn_runtime_ready{job="bayn",namespace="bayn",service="bayn"})',
        'min(bayn_reconciliation_exact{job="bayn",namespace="bayn",service="bayn"} * bayn_reconciliation_covers_latest_mutation{job="bayn",namespace="bayn",service="bayn"} * (bayn_unresolved_mutations{job="bayn",namespace="bayn",service="bayn"} == bool 0))',
        'max by (authority) (bayn_authority_effective{job="bayn",namespace="bayn",service="bayn"} == 1)',
        'max by (condition) (bayn_cycle_condition{job="bayn",namespace="bayn",service="bayn"} == 1)',
        'max by (reason) (bayn_cycle_reason{job="bayn",namespace="bayn",service="bayn"} == 1)',
        'max by (phase) (bayn_cycle_phase{job="bayn",namespace="bayn",service="bayn"} == 1)',
        'min(bayn_execution_session_preflight_ready{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_cycle_snapshot_bound{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_cycle_decision_bound{job="bayn",namespace="bayn",service="bayn"})',
        'max by (status, reason) (bayn_cycle_target_plan_info{job="bayn",namespace="bayn",service="bayn"})',
        'max by (stage) (bayn_execution_funnel_count{job="bayn",namespace="bayn",service="bayn"})',
        'max by (kind) (bayn_cycle_decision_market_data_records{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_broker_position_count{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_broker_gross_exposure_dollars{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_broker_net_exposure_dollars{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_broker_unrealized_pnl_dollars{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_accounting_gross_realized_pnl_dollars{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_accounting_execution_fees_dollars{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_accounting_net_realized_pnl_after_execution_fees_dollars{job="bayn",namespace="bayn",service="bayn"})',
        'max by (profitability) ((bayn_forward_performance_profitability{job="bayn",namespace="bayn",service="bayn"} == 1) and on(instance) topk(1, bayn_forward_performance_receipt_timestamp_seconds{job="bayn",namespace="bayn",service="bayn"}))',
        'max(bayn_unresolved_mutations{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_cycle_submission_open_timestamp_seconds{job="bayn",namespace="bayn",service="bayn"}) * 1000 > 0',
        'max(bayn_cycle_submission_cutoff_timestamp_seconds{job="bayn",namespace="bayn",service="bayn"}) * 1000 > 0',
        'max(bayn_cycle_execution_close_timestamp_seconds{job="bayn",namespace="bayn",service="bayn"}) * 1000 > 0',
        'max(bayn_oldest_unresolved_mutation_age_seconds{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_reconciliation_age_seconds{job="bayn",namespace="bayn",service="bayn"})',
        'max(bayn_autonomous_cycle_loop_last_pass_age_seconds{job="bayn",namespace="bayn",service="bayn"})',
        'max by (source_revision, verification) (bayn_build_info{job="bayn",namespace="bayn",service="bayn"})',
      ]),
    )
    expect(dashboard.panels.find(({ title }) => title === 'Opportunity → fill')?.type).toBe('bargauge')
    expect(dashboardExpressions.join('\n')).not.toContain('bayn_intents{')
    const statPanels = dashboard.panels.filter(({ type }) => type === 'stat')
    expect(statPanels).toHaveLength(29)
    expect(
      statPanels.every(({ targets = [] }) =>
        targets.every(({ instant, range }) => instant === true && range === false),
      ),
    ).toBe(true)
    expect(
      dashboard.panels
        .filter(({ type }) => type === 'state-timeline')
        .every(({ options }) => options?.showValue === 'never'),
    ).toBe(true)
    expect(
      dashboard.panels
        .filter(({ title }) =>
          [
            'Runtime',
            'Execution controller',
            'Broker binding',
            'Ledger safety',
            'Session preflight',
            'Snapshot',
            'Decision',
            'Unresolved mutations',
          ].includes(title),
        )
        .every(({ fieldConfig }) => (fieldConfig?.defaults?.mappings?.length ?? 0) > 0),
    ).toBe(true)
    expect(dashboard.panels.every(({ description }) => description !== undefined && description.length > 0)).toBe(true)
    expect(dashboard.panels.map(({ title }) => title)).not.toEqual(
      expect.arrayContaining(['Metrics scrape', 'Cycle projection', 'Authority and mutation facts', 'Autonomous loop']),
    )
    expect(kustomization).toContain('bayn-cycle-operations-dashboard-configmap.yaml')
    expect(grafanaValues).toContain('bayn-cycle-operations-dashboard: bayn-cycle-operations-dashboard')
    expect([...rules.map(({ expr }) => expr), ...dashboardExpressions].join('\n')).not.toMatch(
      /cycle_id|account_id|decision_hash|mutation_id|client_order_id/,
    )
  })

  test('routes every bounded alert through one source-of-truth recovery contract', () => {
    const runbook = readRepoFile('docs/runbooks/bayn-cycle-operations.md')
    const normalizedRunbook = runbook.replaceAll(/\s+/g, ' ')

    for (const { alert } of baynRules()) {
      expect(runbook).toContain(`\`${alert}\``)
    }
    expect(normalizedRunbook).toContain(
      'An alert clears only when its source-of-truth state changes and the next bounded projection or health probe confirms recovery.',
    )
    expect(normalizedRunbook).toContain(
      'When `cycle.reason=LAST_CYCLE_BLOCKED`, branch on the exact persisted `cycle.last.terminalReason`',
    )
    expect(normalizedRunbook).toContain(
      'compare configured provenance with the embedded source revision, image digest, strategy behavior hash, and strategy parameter hash',
    )
    expect(runbook).toContain('{job="bayn", namespace="bayn"} |= "<trace_id>"')
    expect(runbook).not.toMatch(/clear.*(Prometheus|Mimir|Grafana)|restart.*autonomous cycle loop/i)
  })
})
