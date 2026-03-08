import { describe, expect, it } from 'bun:test'

import { __private } from '../agentrun-ingestion-mitigation'

const buildRun = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: {
    name: 'run-1',
    namespace: 'agents',
    creationTimestamp: '2026-01-20T00:00:00Z',
    generation: 1,
    finalizers: ['agents.proompteng.ai/runtime-cleanup'],
  },
  spec: {
    idempotencyKey: 'key-1',
  },
  status: {
    phase: 'Running',
    observedGeneration: 1,
  },
  ...overrides,
})

describe('agentrun-ingestion-mitigation', () => {
  it('detects untouched AgentRuns from missing phase, observedGeneration, or finalizer', () => {
    const reasons = __private.getUntouchedReasons(
      buildRun({
        metadata: {
          name: 'run-untouched',
          namespace: 'agents',
          creationTimestamp: '2026-01-20T00:00:00Z',
          generation: 3,
          finalizers: [],
        },
        status: {},
      }),
    )

    expect(reasons).toEqual(['missing_phase', 'missing_observed_generation', 'missing_finalizer'])
  })

  it('classifies untouched duplicates with canonical peers as delete candidates', () => {
    const runs = __private.classifyAgentRuns(
      [
        buildRun({
          metadata: { name: 'canonical-run', namespace: 'agents', creationTimestamp: '2026-01-20T00:00:00Z' },
          status: { phase: 'Running', observedGeneration: 1 },
        }),
        buildRun({
          metadata: {
            name: 'untouched-duplicate',
            namespace: 'agents',
            creationTimestamp: '2026-01-20T00:10:00Z',
            generation: 1,
            finalizers: [],
          },
          status: {},
        }),
      ],
      new Date('2026-01-20T00:30:00Z'),
      120,
    )

    const duplicate = runs.find((run) => run.name === 'untouched-duplicate')
    expect(duplicate?.classification).toBe('untouched')
    expect(duplicate?.deleteCandidate).toBe(true)
    expect(duplicate?.recreateCandidate).toBe(false)
    expect(duplicate?.canonicalRunName).toBe('canonical-run')
  })

  it('classifies untouched runs without canonical peers as recreate candidates', () => {
    const runs = __private.classifyAgentRuns(
      [
        buildRun({
          metadata: {
            name: 'untouched-only',
            namespace: 'agents',
            creationTimestamp: '2026-01-20T00:00:00Z',
            generation: 1,
            finalizers: [],
          },
          status: {},
        }),
      ],
      new Date('2026-01-20T00:30:00Z'),
      120,
    )

    expect(runs[0]?.recreateCandidate).toBe(true)
    expect(runs[0]?.deleteCandidate).toBe(false)
  })

  it('strips controller-managed metadata when recreating a run', () => {
    const manifest = __private.sanitizeForRecreate(
      buildRun({
        metadata: {
          name: 'run-recreate',
          namespace: 'agents',
          creationTimestamp: '2026-01-20T00:00:00Z',
          generation: 7,
          uid: 'uid-1',
          resourceVersion: '12',
          managedFields: [{ manager: 'controller' }],
          finalizers: ['agents.proompteng.ai/runtime-cleanup'],
        },
        status: {
          phase: 'Pending',
          observedGeneration: 7,
        },
      }),
    )

    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>
    expect(metadata.uid).toBeUndefined()
    expect(metadata.resourceVersion).toBeUndefined()
    expect(metadata.managedFields).toBeUndefined()
    expect(metadata.creationTimestamp).toBeUndefined()
    expect(metadata.generation).toBeUndefined()
    expect(metadata.finalizers).toBeUndefined()
    expect((manifest as Record<string, unknown>).status).toBeUndefined()
  })

  it('normalizes leader identity to pod name', () => {
    expect(
      __private.normalizeLeaderPodName('agents-controllers-6bb744f44f-4t6sr_436b0c45-3791-4bfc-822f-c70e6ff1d6f2'),
    ).toBe('agents-controllers-6bb744f44f-4t6sr')
  })
})
