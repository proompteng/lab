import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP, type KubernetesClient } from './kube-types'
import { reconcileMaterialReentryRequirementSignals } from './swarm-material-reentry'

const createKubeMock = (existingSignals: Record<string, unknown>[] = []) => {
  const applied: Record<string, unknown>[] = []
  const kube: Pick<KubernetesClient, 'apply' | 'list'> = {
    apply: vi.fn(async (resource) => {
      applied.push(resource)
      return resource
    }),
    list: vi.fn(async (resource) => {
      if (resource === RESOURCE_MAP.Signal) return { items: existingSignals }
      return { items: [] }
    }),
  }
  return { kube: kube as KubernetesClient, applied }
}

const buildSwarm = (dispatches: Record<string, unknown>[]) => ({
  apiVersion: 'swarm.proompteng.ai/v1alpha1',
  kind: 'Swarm',
  metadata: { name: 'runtime-workers', namespace: 'agents', generation: 1 },
  status: {
    material_reentry_clearinghouse: {
      implementer_dispatches: dispatches,
    },
  },
})

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

describe('swarm material reentry reconciler', () => {
  it('applies missing material reentry requirement Signals from Swarm status', async () => {
    const { kube, applied } = createKubeMock()

    const result = await reconcileMaterialReentryRequirementSignals(
      kube,
      buildSwarm([
        buildDispatch('material-reentry-first', 'repair-routeable-candidates'),
        buildDispatch('material-reentry-second', 'repair-routeable-candidates'),
      ]),
      'agents',
    )

    expect(kube.list).toHaveBeenCalledWith(RESOURCE_MAP.Signal, 'agents')
    expect(result.applyErrors).toBe(0)
    expect(result.plannedSignals).toHaveLength(1)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({
      apiVersion: 'signals.proompteng.ai/v1alpha1',
      kind: 'Signal',
      metadata: {
        namespace: 'agents',
        labels: {
          'swarm.proompteng.ai/to': 'runtime-workers',
          'swarm.proompteng.ai/type': 'requirement',
        },
        annotations: {
          'swarm.proompteng.ai/material-reentry-dispatch': 'repair-routeable-candidates',
          'swarm.proompteng.ai/material-reentry-source-signal': 'material-reentry-second',
        },
      },
      spec: {
        channel: 'agentrun.general.requirement',
        priority: 'high',
        payload: {
          material_reentry_dispatch_dedupe_key: 'repair-routeable-candidates',
        },
      },
    })
  })

  it('skips material reentry requirement Signals that already carry the dispatch key', async () => {
    const { kube, applied } = createKubeMock([
      {
        kind: 'Signal',
        metadata: {
          name: 'already-published',
          annotations: { 'swarm.proompteng.ai/material-reentry-dispatch': 'repair-routeable-candidates' },
        },
      },
    ])

    const result = await reconcileMaterialReentryRequirementSignals(
      kube,
      buildSwarm([buildDispatch('material-reentry-next', 'repair-routeable-candidates')]),
      'agents',
    )

    expect(result.plannedSignals).toHaveLength(0)
    expect(applied).toHaveLength(0)
  })
})
