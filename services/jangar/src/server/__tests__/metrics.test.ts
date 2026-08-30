import { AggregationTemporality, type ResourceMetrics } from '@proompteng/otel/sdk-metrics'
import { describe, expect, it } from 'vitest'

import { __private } from '../metrics'

describe('metrics Prometheus rendering', () => {
  it('serializes counter and histogram metrics', () => {
    const resourceMetrics: ResourceMetrics = {
      resource: { attributes: [] },
      scopeMetrics: [
        {
          scope: { name: 'jangar' },
          metrics: [
            {
              name: 'jangar_sse_connections_total',
              description: 'Count of SSE connections opened/closed.',
              sum: {
                aggregationTemporality: AggregationTemporality.CUMULATIVE,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [
                      { key: 'stream', value: { stringValue: 'chat' } },
                      { key: 'state', value: { stringValue: 'opened' } },
                    ],
                    startTimeUnixNano: '1',
                    timeUnixNano: '2',
                    asDouble: 3,
                  },
                ],
              },
            },
            {
              name: 'jangar_agents_queue_depth',
              description: 'Observed queue depth for AgentRun admission control.',
              histogram: {
                aggregationTemporality: AggregationTemporality.CUMULATIVE,
                dataPoints: [
                  {
                    attributes: [{ key: 'queue', value: { stringValue: 'default' } }],
                    startTimeUnixNano: '1',
                    timeUnixNano: '2',
                    count: '2',
                    sum: 7,
                    min: 3,
                    max: 4,
                    bucketCounts: ['2'],
                    explicitBounds: [],
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const rendered = __private.serializeResourceMetricsToPrometheus(resourceMetrics)

    expect(rendered).toContain('# TYPE jangar_sse_connections_total counter')
    expect(rendered).toContain('jangar_sse_connections_total{state="opened",stream="chat"} 3')
    expect(rendered).toContain('# TYPE jangar_agents_queue_depth histogram')
    expect(rendered).toContain('jangar_agents_queue_depth_bucket{le="+Inf",queue="default"} 2')
    expect(rendered).toContain('jangar_agents_queue_depth_sum{queue="default"} 7')
    expect(rendered).toContain('jangar_agents_queue_depth_count{queue="default"} 2')
  })

  it('sanitizes metric names and label keys', () => {
    const resourceMetrics: ResourceMetrics = {
      resource: { attributes: [] },
      scopeMetrics: [
        {
          scope: { name: 'jangar' },
          metrics: [
            {
              name: 'jangar.metric-name',
              sum: {
                aggregationTemporality: AggregationTemporality.CUMULATIVE,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [{ key: 'team-name', value: { stringValue: 'agents' } }],
                    startTimeUnixNano: '1',
                    timeUnixNano: '2',
                    asDouble: 1,
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const rendered = __private.serializeResourceMetricsToPrometheus(resourceMetrics)
    expect(rendered).toContain('# TYPE jangar_metric_name counter')
    expect(rendered).toContain('jangar_metric_name{team_name="agents"} 1')
  })

  it('returns a comment when no metrics are collected', () => {
    expect(__private.serializeResourceMetricsToPrometheus(null)).toBe('# no metrics collected\n')
  })
})
