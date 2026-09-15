import { describe, expect, it } from 'vitest'

import {
  AGENTS_RESOURCE_LABELS,
  buildDeliveryIdLabels,
  buildOrchestrationChildLabels,
  buildToolRunJobLabels,
  readDeliveryIdLabel,
  readOrchestrationRunLabel,
  readToolRunLabel,
} from './agent-resource-labels'

describe('Agents resource labels', () => {
  it('emits canonical labels only for new resources', () => {
    expect(buildDeliveryIdLabels('delivery-1')).toEqual({
      [AGENTS_RESOURCE_LABELS.deliveryId.canonical]: 'delivery-1',
    })
    expect(buildOrchestrationChildLabels('orch-1', 'step-1')).toMatchObject({
      [AGENTS_RESOURCE_LABELS.orchestrationRun.canonical]: 'orch-1',
      [AGENTS_RESOURCE_LABELS.orchestrationStep.canonical]: 'step-1',
    })
    expect(buildToolRunJobLabels('toolrun-1')).toEqual({
      [AGENTS_RESOURCE_LABELS.toolRun.canonical]: 'toolrun-1',
    })
  })

  it('normalizes arbitrary delivery ids into Kubernetes-safe label values', () => {
    const labels = buildDeliveryIdLabels('domain/request:with/slashes and spaces that is far too long for a label')
    const value = labels[AGENTS_RESOURCE_LABELS.deliveryId.canonical]

    expect(value).toMatch(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/)
    expect(value.length).toBeLessThanOrEqual(63)
    expect(value).toContain('-')
  })

  it('reads canonical labels only', () => {
    expect(
      readDeliveryIdLabel({
        metadata: {
          labels: {
            [AGENTS_RESOURCE_LABELS.deliveryId.canonical]: 'canonical-delivery',
          },
        },
      }),
    ).toBe('canonical-delivery')

    expect(
      readOrchestrationRunLabel({
        metadata: { labels: { 'legacy.proompteng.ai/orchestration-run': 'legacy-orch' } },
      }),
    ).toBeUndefined()

    expect(
      readToolRunLabel({
        metadata: { labels: { 'legacy.proompteng.ai/tool-run': 'legacy-toolrun' } },
      }),
    ).toBeUndefined()
  })
})
