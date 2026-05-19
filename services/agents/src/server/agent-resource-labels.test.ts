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

  it('prefers canonical labels but still reads legacy labels', () => {
    expect(
      readDeliveryIdLabel({
        metadata: {
          labels: {
            [AGENTS_RESOURCE_LABELS.deliveryId.legacy]: 'legacy-delivery',
            [AGENTS_RESOURCE_LABELS.deliveryId.canonical]: 'canonical-delivery',
          },
        },
      }),
    ).toBe('canonical-delivery')

    expect(
      readOrchestrationRunLabel({
        metadata: { labels: { [AGENTS_RESOURCE_LABELS.orchestrationRun.legacy]: 'legacy-orch' } },
      }),
    ).toBe('legacy-orch')

    expect(
      readToolRunLabel({
        metadata: { labels: { [AGENTS_RESOURCE_LABELS.toolRun.legacy]: 'legacy-toolrun' } },
      }),
    ).toBe('legacy-toolrun')
  })
})
