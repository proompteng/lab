import { describe, expect, it, vi } from 'vitest'

import { createAgentRunReconciler, resolveProviderReadinessBlock } from './agent-run-reconciler'
import { PROVIDER_CAPACITY_EXHAUSTED_REASON } from './provider-capacity'
import { RESOURCE_MAP } from '../kube-types'

describe('agents controller agent-run reconciler', () => {
  it('recognizes provider capacity readiness blocks', () => {
    expect(
      resolveProviderReadinessBlock({
        metadata: { name: 'codex-spark' },
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
              message: 'provider capacity exhausted: Quota exceeded.',
            },
          ],
        },
      }),
    ).toEqual({
      reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
      message: 'agent provider codex-spark is not ready: provider capacity exhausted: Quota exceeded.',
    })

    expect(
      resolveProviderReadinessBlock({
        metadata: { name: 'codex-spark' },
        status: { conditions: [{ type: 'Ready', status: 'False', reason: 'MissingBinary' }] },
      }),
    ).toBeNull()
  })

  it('blocks a new AgentRun without submitting a Job when provider capacity is exhausted', async () => {
    const setStatus = vi.fn(async () => undefined)
    const submitJobRun = vi.fn()
    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async (kind: string) => {
        if (kind === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'codex-agent' },
            spec: { providerRef: { name: 'codex-spark' } },
          }
        }
        if (kind === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'codex-spark' },
            status: {
              conditions: [
                {
                  type: 'Ready',
                  status: 'False',
                  reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
                  message: 'provider capacity exhausted: Quota exceeded.',
                },
              ],
            },
          }
        }
        return null
      }),
    }
    const reconciler = createAgentRunReconciler({
      setStatus,
      nowIso: () => '2026-05-18T14:00:00.000Z',
      isKubeNotFoundError: () => false,
      resolveJobImage: () => 'registry.example/runner:latest',
      resolveAgentRunRetentionSeconds: () => 0,
      getPrimitivesStore: async () => null,
      getTemporalClient: async () => ({}),
      reconcileWorkflowRun: vi.fn(),
      submitJobRun,
      submitCustomRun: vi.fn(),
      submitTemporalRun: vi.fn(),
      reconcileTemporalRun: vi.fn(),
      buildConditions: () => [],
      isAgentRunImmutabilityEnforced: () => true,
      isAgentRunIdempotencyEnabled: () => false,
      parseQueueLimits: () => ({ perNamespace: 0, perRepo: 0, cluster: 0 }),
      parseRateLimits: () => ({ perNamespace: 0, perRepo: 0, cluster: 0, windowSeconds: 60 }),
      getControllerSnapshot: () => null,
      getControllerRateState: () => ({
        cluster: { count: 0, resetAt: 0 },
        perNamespace: new Map(),
        perRepo: new Map(),
      }),
      validateImplementationContract: () => ({ ok: true, requiredKeys: [] }),
      buildContractStatus: () => undefined,
      resolveRunnerServiceAccount: () => null,
      applyJobTtlAfterStatus: vi.fn(),
      isJobComplete: () => false,
      isJobFailed: () => false,
    })

    await reconciler.reconcileAgentRun(
      kube as never,
      {
        metadata: { name: 'run-1', namespace: 'agents', generation: 1 },
        spec: {
          agentRef: { name: 'codex-agent' },
          runtime: { type: 'job' },
          parameters: {},
          workload: {},
        },
      },
      'agents',
      [],
      [],
      {
        perNamespace: 10,
        perAgent: 10,
        cluster: 10,
        repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
      },
      { total: 0, perAgent: new Map(), perRepository: new Map() },
      0,
    )

    expect(submitJobRun).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenLastCalledWith(
      kube,
      expect.any(Object),
      expect.objectContaining({
        phase: 'Pending',
        reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
        message: expect.stringContaining('provider capacity exhausted'),
      }),
    )
  })
})
