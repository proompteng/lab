import { describe, expect, it } from 'vitest'

import {
  MATERIAL_REENTRY_DISPATCH_ANNOTATION,
  MATERIAL_REENTRY_SOURCE_SIGNAL_ANNOTATION,
  planMaterialReentryRequirementSignalInputs,
  readMaterialReentryRequirementSignals,
} from './swarm-material-reentry'

const buildDispatch = (signalName: string, dedupeKey: string) => ({
  dispatch_kind: 'swarm_requirement_signal',
  signal_name: signalName,
  source_swarm: 'source-control-plane',
  target_swarm: 'runtime-workers',
  target_stage: 'implement',
  channel: 'agentrun.general.requirement',
  description: 'repair executable evidence',
  priority: 'high',
  dedupe_key: dedupeKey,
  payload: { value_gate: 'routeable_candidate_count' },
})

describe('swarm material reentry contract', () => {
  it('reads material reentry requirement signals and deduplicates by dispatch key', () => {
    const signals = readMaterialReentryRequirementSignals({
      material_reentry_clearinghouse: {
        implementer_dispatches: [
          buildDispatch('material-reentry-first', 'repair-routeable-candidates'),
          buildDispatch('material-reentry-second', 'repair-routeable-candidates'),
        ],
      },
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      signalName: 'material-reentry-second',
      sourceSwarm: 'source-control-plane',
      targetSwarm: 'runtime-workers',
      targetStage: 'implement',
      dedupeKey: 'repair-routeable-candidates',
    })
  })

  it('plans stable Signal inputs and skips duplicate dispatch keys', () => {
    const materialReentryRequirementSignals = readMaterialReentryRequirementSignals({
      material_reentry_clearinghouse: {
        implementer_dispatches: [
          buildDispatch('material-reentry-first', 'repair-routeable-candidates'),
          buildDispatch('material-reentry-second', 'repair-routeable-candidates'),
        ],
      },
    })

    const signals = planMaterialReentryRequirementSignalInputs({
      namespace: 'agents',
      swarmName: 'runtime-workers',
      existingSignals: [],
      materialReentryRequirementSignals,
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]?.name).toMatch(/^material-reentry-runtime-workers-[a-z0-9]+$/)
    expect(signals[0]).toMatchObject({
      deliveryId: 'repair-routeable-candidates',
      sourceSwarm: 'source-control-plane',
      targetSwarm: 'runtime-workers',
      annotations: {
        [MATERIAL_REENTRY_DISPATCH_ANNOTATION]: 'repair-routeable-candidates',
        [MATERIAL_REENTRY_SOURCE_SIGNAL_ANNOTATION]: 'material-reentry-second',
      },
      payload: {
        material_reentry_dispatch_dedupe_key: 'repair-routeable-candidates',
      },
    })
  })

  it('skips material reentry Signals when an existing Signal carries the dispatch key', () => {
    const materialReentryRequirementSignals = readMaterialReentryRequirementSignals({
      material_reentry_clearinghouse: {
        implementer_dispatches: [buildDispatch('material-reentry-next', 'repair-routeable-candidates')],
      },
    })

    const signals = planMaterialReentryRequirementSignalInputs({
      namespace: 'agents',
      swarmName: 'runtime-workers',
      existingSignals: [
        {
          kind: 'Signal',
          metadata: {
            name: 'already-published',
            annotations: { [MATERIAL_REENTRY_DISPATCH_ANNOTATION]: 'repair-routeable-candidates' },
          },
        },
      ],
      materialReentryRequirementSignals,
    })

    expect(signals).toHaveLength(0)
  })
})
