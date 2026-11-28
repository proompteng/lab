import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __private,
  configureAgentsMetricsSink,
  recordAgentQueueDepth,
  recordAgentRateLimitRejection,
  recordAgentRunOutcome,
  recordAgentRunUntouchedBacklog,
  recordReconcileDurationMs,
  recordRunnerCompletion,
  recordSseConnection,
  renderAgentsPrometheusMetrics,
} from './metrics'
import { runnerTelemetrySchema } from '../runner-telemetry'

const now = Date.parse('2026-11-28T02:00:00Z')
const quotaReset = now / 1000 + 3600
const telemetry = runnerTelemetrySchema.parse({
  version: 1,
  state: 'finished',
  startedAt: '2026-11-28T01:59:30Z',
  heartbeatAt: '2026-11-28T02:00:00Z',
  lastActivityAt: null,
  podName: 'run-unique-job-unique',
  model: 'gpt-6.2-sol',
  effort: 'max',
  threadId: 'unique-thread',
  turnId: 'unique-turn',
  activeTools: [],
  activeToolCount: 0,
  usage: {
    inputTokens: 120,
    cachedInputTokens: 90,
    cacheWriteInputTokens: 1,
    outputTokens: 10,
    reasoningOutputTokens: 8,
    totalTokens: 130,
  },
  quota: {
    limitId: 'codex',
    primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: quotaReset },
    secondary: { usedPercent: 89, windowDurationMins: 10080, resetsAt: quotaReset },
  },
  publishErrors: 2,
})

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
    expect(rendered).toContain('agents_reconcile_duration_ms_bucket{kind="agentrun",le="10",namespace="agents"} 0')
    expect(rendered).toContain('agents_reconcile_duration_ms_bucket{kind="agentrun",le="50",namespace="agents"} 1')
    expect(rendered).toContain('agents_reconcile_duration_ms_bucket{kind="agentrun",le="+Inf",namespace="agents"} 1')
    expect(rendered).toContain('agents_reconcile_duration_ms_sum{kind="agentrun",namespace="agents"} 42')
    expect(rendered).toContain('agents_agent_queue_depth{namespace="agents",scope="namespace"} 7')
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

  it('overwrites a drained backlog instead of retaining the old observation', () => {
    recordAgentRunUntouchedBacklog(20, { namespace: 'synthesis' })
    recordAgentRunUntouchedBacklog(0, { namespace: 'synthesis' })
    expect(renderAgentsPrometheusMetrics()).toContain('agents_agentrun_untouched_backlog{namespace="synthesis"} 0\n')
  })

  it('aggregates completed-run telemetry without exposing run, pod or thread identifiers', () => {
    const completion = { outcome: 'Succeeded' as const, agent: 'codex', durationSeconds: 30, telemetry }
    recordRunnerCompletion(completion, now)
    recordRunnerCompletion(completion, now)
    const rendered = renderAgentsPrometheusMetrics(now)

    expect(rendered).toContain('# TYPE agents_runner_tokens_total counter')
    for (const [direction, value] of Object.entries({ input: 240, cached_input: 180, output: 20, reasoning: 16 })) {
      expect(rendered).toContain(
        `agents_runner_tokens_total{direction="${direction}",effort="max",model="gpt-6.2-sol"} ${value}\n`,
      )
    }
    expect(rendered).toContain('# TYPE agents_runner_quota_used_percent gauge')
    expect(rendered).toContain('agents_runner_quota_used_percent{limit_id="codex"} 89\n')
    expect(rendered).toContain('# TYPE agents_runner_run_duration_seconds histogram')
    expect(rendered).toContain(
      'agents_runner_run_duration_seconds_bucket{effort="max",le="10",model="gpt-6.2-sol",outcome="Succeeded"} 0\n',
    )
    expect(rendered).toContain(
      'agents_runner_run_duration_seconds_bucket{effort="max",le="30",model="gpt-6.2-sol",outcome="Succeeded"} 2\n',
    )
    expect(rendered).toContain('agents_runner_telemetry_publish_errors_total{agent="codex"} 4\n')
    expect(rendered).not.toMatch(/agent_run_name|uid=|unique-/)
  })

  it('ignores a short window, keeps the highest snapshot in the same weekly window, and expires it on reset', () => {
    expect(telemetry.quota).not.toBeNull()
    const quota = { ...telemetry.quota!, secondary: null }
    const record = (quota: NonNullable<typeof telemetry.quota>) =>
      recordRunnerCompletion({ outcome: 'Succeeded', telemetry: { ...telemetry, quota } }, now)
    record(quota)
    expect(renderAgentsPrometheusMetrics(now)).not.toContain('agents_runner_quota_used_percent')
    record({ ...quota, primary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: quotaReset } })
    record({ ...quota, secondary: { usedPercent: 87, windowDurationMins: 10080, resetsAt: quotaReset } })
    expect(renderAgentsPrometheusMetrics(now)).toContain('agents_runner_quota_used_percent{limit_id="codex"} 90\n')
    expect(renderAgentsPrometheusMetrics(quotaReset * 1000)).not.toContain('agents_runner_quota_used_percent')
  })

  it('collapses excess label values and does not emit missing telemetry as zeros', () => {
    recordRunnerCompletion({
      outcome: 'Cancelled',
      model: 'unknown-model',
      effort: 'per-run-effort',
      durationSeconds: 5,
    })
    for (let index = 0; index < 20; index++) {
      recordRunnerCompletion({
        outcome: 'Failed',
        model: `model-${index}`,
        effort: 'per-run-effort',
        durationSeconds: 5,
      })
    }
    const rendered = renderAgentsPrometheusMetrics()
    expect(rendered).not.toContain('agents_runner_tokens_total')
    expect(rendered).not.toContain('agents_runner_telemetry_publish_errors_total')
    expect(rendered).not.toContain('per-run-effort')
    expect(rendered).not.toContain('model="model-19"')
    expect(rendered).toContain(
      'agents_runner_run_duration_seconds_count{effort="other",model="other",outcome="Failed"} 5\n',
    )
  })

  it('returns a comment when no metrics are collected', () => {
    expect(renderAgentsPrometheusMetrics()).toBe('# no metrics collected\n')
  })
})
