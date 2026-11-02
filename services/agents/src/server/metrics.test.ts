import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __private,
  configureAgentsMetricsSink,
  recordAgentQueueDepth,
  recordAgentRateLimitRejection,
  recordAgentRunOutcome,
  recordReconcileDurationMs,
  recordSseConnection,
  renderAgentsPrometheusMetrics,
} from './metrics'

describe('Agents metrics', () => {
  afterEach(() => {
    __private.resetMetricsForTest()
  })

  it('renders Agents-owned Prometheus counters and histograms', () => {
    recordAgentRunOutcome('Succeeded', { runtime: 'workflow' })
    recordAgentRunOutcome('Succeeded', { runtime: 'workflow' })
    recordReconcileDurationMs(42, { kind: 'agentrun', namespace: 'agents' })
    recordAgentQueueDepth(7, { scope: 'namespace', namespace: 'agents' })
    recordSseConnection('control-plane', 'opened')

    const rendered = renderAgentsPrometheusMetrics()

    expect(rendered).toContain('# TYPE agents_agent_run_outcomes_total counter')
    expect(rendered).toContain('agents_agent_run_outcomes_total{outcome="Succeeded",runtime="workflow"} 2')
    expect(rendered).toContain('# TYPE agents_reconcile_duration_ms histogram')
    expect(rendered).toContain('agents_reconcile_duration_ms_bucket{kind="agentrun",le="+Inf",namespace="agents"} 1')
    expect(rendered).toContain('agents_reconcile_duration_ms_sum{kind="agentrun",namespace="agents"} 42')
    expect(rendered).toContain('agents_agent_queue_depth_bucket{le="+Inf",namespace="agents",scope="namespace"} 1')
    expect(rendered).toContain('agents_sse_connections_total{state="opened",stream="control-plane"} 1')
    expect(rendered).not.toContain('jangar_')
  })

  it('forwards records to configured external sinks', () => {
    const sink = {
      recordAgentRateLimitRejection: vi.fn(),
    }
    configureAgentsMetricsSink(sink)

    recordAgentRateLimitRejection('repo', { repository: 'proompteng/lab' })

    expect(sink.recordAgentRateLimitRejection).toHaveBeenCalledWith('repo', { repository: 'proompteng/lab' })
    expect(renderAgentsPrometheusMetrics()).toContain(
      'agents_rate_limit_rejections_total{repository="proompteng/lab",scope="repo"} 1',
    )
  })

  it('sanitizes names and labels', () => {
    recordAgentQueueDepth(1, {
      'queue-name': 'agent "default"',
      '9bad': 'line\nbreak',
    })

    const rendered = renderAgentsPrometheusMetrics()

    expect(__private.sanitizePrometheusName('agents.metric-name')).toBe('agents_metric_name')
    expect(rendered).toContain('_9bad="line\\nbreak"')
    expect(rendered).toContain('queue_name="agent \\"default\\""')
  })

  it('returns a comment when no metrics are collected', () => {
    expect(renderAgentsPrometheusMetrics()).toBe('# no metrics collected\n')
  })
})
