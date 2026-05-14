import { describe, expect, it, vi } from 'vitest'

import { publishMaterialReentryRequirementSignals } from '~/server/supporting-primitives-material-reentry-requirements'

const buildDispatch = (signalName: string, dedupeKey: string) => ({
  signalName,
  sourceSwarm: 'jangar-control-plane',
  targetSwarm: 'torghut-quant',
  targetStage: 'implement' as const,
  channel: 'workflow.general.requirement',
  description: 'repair executable alpha evidence',
  priority: 'high',
  dedupeKey,
  payload: { value_gate: 'routeable_candidate_count' },
})

describe('supporting-primitives-material-reentry-requirements', () => {
  it('deduplicates material reentry requirement signals by dispatch key', async () => {
    const apply = vi.fn().mockResolvedValue({})

    const result = await publishMaterialReentryRequirementSignals({
      kube: { apply },
      namespace: 'agents',
      swarmName: 'torghut-quant',
      existingSignalNames: new Set(),
      materialReentryRequirementSignals: [
        buildDispatch('material-reentry-torghut-alpha-first', 'repair-routeable-candidates'),
        buildDispatch('material-reentry-torghut-alpha-second', 'repair-routeable-candidates'),
      ],
    })

    expect(result.publishErrors).toBe(0)
    expect(result.publishedSignals).toHaveLength(1)
    expect(apply).toHaveBeenCalledTimes(1)
    const signal = apply.mock.calls[0]?.[0] as Record<string, unknown>
    const metadata = signal.metadata as Record<string, unknown>
    expect(metadata.name).toMatch(/^material-reentry-torghut-quant-[a-z0-9]+$/)
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      metadata: {
        annotations: {
          'swarm.proompteng.ai/material-reentry-dispatch': 'repair-routeable-candidates',
          'swarm.proompteng.ai/material-reentry-source-signal': 'material-reentry-torghut-alpha-first',
        },
      },
    })
  })

  it('skips material reentry signals when the dispatch key already exists', async () => {
    const apply = vi.fn().mockResolvedValue({})

    const result = await publishMaterialReentryRequirementSignals({
      kube: { apply },
      namespace: 'agents',
      swarmName: 'torghut-quant',
      existingSignalNames: new Set(),
      existingDedupeKeys: new Set(['repair-routeable-candidates']),
      materialReentryRequirementSignals: [
        buildDispatch('material-reentry-torghut-alpha-next', 'repair-routeable-candidates'),
      ],
    })

    expect(result.publishErrors).toBe(0)
    expect(result.publishedSignals).toHaveLength(0)
    expect(apply).not.toHaveBeenCalled()
  })
})
