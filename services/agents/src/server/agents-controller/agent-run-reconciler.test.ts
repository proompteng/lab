import { describe, expect, it, vi } from 'vitest'

import { createAgentRunReconciler, resolveProviderReadinessBlock } from './agent-run-reconciler'
import { PROVIDER_CAPACITY_EXHAUSTED_REASON } from './provider-capacity'
import { RESOURCE_MAP } from '../kube-types'

describe('agents controller agent-run reconciler', () => {
  const createBaseDependencies = (overrides: Partial<Parameters<typeof createAgentRunReconciler>[0]> = {}) => ({
    setStatus: vi.fn(async () => undefined),
    nowIso: () => '2026-05-18T14:00:00.000Z',
    isKubeNotFoundError: () => false,
    resolveJobImage: () => 'registry.example/runner:latest',
    getAgentRunRetentionDecision: () => ({ eligible: false }),
    getPrimitivesStore: async () => null,
    getTemporalClient: async () => ({}),
    reconcileWorkflowRun: vi.fn(),
    submitJobRun: vi.fn(),
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
    validateImplementationContract: () => ({ ok: true as const, requiredKeys: [] }),
    buildContractStatus: () => undefined,
    resolveRunnerServiceAccount: () => null,
    applyJobTtlAfterStatus: vi.fn(),
    verifyJobConfigMaps: vi.fn(async () => ({ ok: true as const, names: [] })),
    isJobComplete: () => false,
    isJobFailed: () => false,
    ...overrides,
  })

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
    const reconciler = createAgentRunReconciler(
      createBaseDependencies({
        setStatus,
        submitJobRun,
      }),
    )

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

  it('uses AgentProvider workload image when a job AgentRun omits its workload image', async () => {
    const submitJobRun = vi.fn(async () => ({
      type: 'job',
      name: 'run-1-job',
      namespace: 'agents',
    }))
    const resolveJobImage = vi.fn((_workload: Record<string, unknown>, provider?: Record<string, unknown> | null) => {
      const workload = provider?.spec as Record<string, unknown> | undefined
      return ((workload?.workload as Record<string, unknown> | undefined)?.image as string | undefined) ?? null
    })
    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async (kind: string) => {
        if (kind === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'anypi-agent' },
            spec: {
              providerRef: { name: 'anypi' },
              defaults: { systemPrompt: 'You are a production coding agent.' },
            },
          }
        }
        if (kind === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'anypi' },
            spec: {
              binary: '/usr/local/bin/anypi-runner',
              workload: {
                image:
                  'registry.ide-newton.ts.net/lab/anypi:9cd6ed580@sha256:b6f90e286832458ee228472a066ba1249536bef2d53618014164f70b85e01990',
              },
            },
          }
        }
        return null
      }),
    }
    const reconciler = createAgentRunReconciler(
      createBaseDependencies({
        resolveJobImage,
        submitJobRun,
      }),
    )

    await reconciler.reconcileAgentRun(
      kube as never,
      {
        metadata: { name: 'run-1', namespace: 'agents', generation: 1 },
        spec: {
          agentRef: { name: 'anypi-agent' },
          runtime: { type: 'job' },
          implementation: { inline: { text: 'Implement the requested change.' } },
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

    expect(resolveJobImage).toHaveBeenCalledWith({}, expect.objectContaining({ metadata: { name: 'anypi' } }))
    expect(submitJobRun).toHaveBeenCalledWith(
      kube,
      expect.any(Object),
      expect.objectContaining({ metadata: { name: 'anypi-agent' } }),
      expect.objectContaining({ metadata: { name: 'anypi' } }),
      expect.any(Object),
      null,
      'agents',
      'registry.ide-newton.ts.net/lab/anypi:9cd6ed580@sha256:b6f90e286832458ee228472a066ba1249536bef2d53618014164f70b85e01990',
      'job',
      expect.any(Object),
    )
  })

  it('rejects a direct AgentRun whose implementation source is not allowed by the Agent', async () => {
    const setStatus = vi.fn(async () => undefined)
    const submitJobRun = vi.fn()
    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async (kind: string) => {
        if (kind === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'codex-linear-agent' },
            spec: {
              providerRef: { name: 'codex-linear' },
              security: { allowedImplementationSourceProviders: ['linear'] },
            },
          }
        }
        if (kind === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'codex-linear' }, spec: {} }
        }
        return null
      }),
    }
    const reconciler = createAgentRunReconciler(
      createBaseDependencies({
        setStatus,
        submitJobRun,
      }),
    )

    await reconciler.reconcileAgentRun(
      kube as never,
      {
        metadata: { name: 'run-1', namespace: 'agents', generation: 1 },
        spec: {
          agentRef: { name: 'codex-linear-agent' },
          runtime: { type: 'job' },
          implementation: {
            inline: {
              source: { provider: 'github', externalId: '123' },
              text: 'Implement the issue.',
            },
          },
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
        phase: 'Failed',
        conditions: expect.arrayContaining([
          expect.objectContaining({
            type: 'InvalidSpec',
            reason: 'ImplementationSourceProviderNotAllowed',
          }),
        ]),
      }),
    )
  })

  it('finalizes a running job AgentRun from stored terminal runner status when the Job was already pruned', async () => {
    const setStatus = vi.fn(async () => undefined)
    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async () => null),
    }
    const reconciler = createAgentRunReconciler(createBaseDependencies({ setStatus }))

    await reconciler.reconcileAgentRun(
      kube as never,
      {
        metadata: {
          name: 'run-1',
          namespace: 'agents',
          generation: 1,
          finalizers: ['agents.proompteng.ai/runtime-cleanup'],
        },
        spec: {
          agentRef: { name: 'codex-agent' },
          runtime: { type: 'job' },
          parameters: {},
          workload: {},
        },
        status: {
          phase: 'Running',
          startedAt: '2026-05-18T13:00:00.000Z',
          runtimeRef: {
            type: 'job',
            name: 'run-1-job',
            namespace: 'agents',
            jobObservedAt: '2026-05-18T13:00:01.000Z',
          },
          runner: {
            status: 'succeeded',
            provider: 'codex-app-server',
            exitCode: 0,
            startedAt: '2026-05-18T13:00:02.000Z',
            finishedAt: '2026-05-18T13:08:00.000Z',
            artifacts: {
              outputArtifacts: [{ name: 'runner-log', path: '/workspace/.agent/runner.log' }],
            },
          },
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

    expect(kube.get).toHaveBeenCalledWith('job', 'run-1-job', 'agents')
    expect(setStatus).toHaveBeenCalledWith(
      kube,
      expect.any(Object),
      expect.objectContaining({
        phase: 'Succeeded',
        reason: undefined,
        message: undefined,
        finishedAt: '2026-05-18T13:08:00.000Z',
        runner: expect.objectContaining({ status: 'succeeded', exitCode: 0 }),
        artifacts: [{ name: 'runner-log', path: '/workspace/.agent/runner.log' }],
        conditions: expect.arrayContaining([
          expect.objectContaining({ type: 'Warning', status: 'True', reason: 'JobMissing' }),
          expect.objectContaining({ type: 'Succeeded', status: 'True', reason: 'Completed' }),
        ]),
      }),
    )
  })

  it('returns terminal preserved AgentRuns without normal reconcile logging or runtime reconciliation', async () => {
    const setStatus = vi.fn(async () => undefined)
    const reconcileWorkflowRun = vi.fn()
    const kube = {
      patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    }
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const reconciler = createAgentRunReconciler(createBaseDependencies({ setStatus, reconcileWorkflowRun }))

    try {
      await reconciler.reconcileAgentRun(
        kube as never,
        {
          metadata: {
            name: 'old-workflow-run',
            namespace: 'agents',
            generation: 1,
            finalizers: ['agents.proompteng.ai/runtime-cleanup'],
          },
          spec: {
            agentRef: { name: 'codex-agent' },
            runtime: { type: 'workflow' },
            ttlSecondsAfterFinished: 0,
            parameters: {},
          },
          status: {
            observedGeneration: 1,
            phase: 'Succeeded',
            finishedAt: '2026-05-18T13:08:00.000Z',
            runtimeRef: {
              type: 'workflow',
              name: 'old-workflow-run-workflow',
              namespace: 'agents',
            },
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
    } finally {
      infoSpy.mockRestore()
    }

    expect(kube.patch).not.toHaveBeenCalled()
    expect(kube.delete).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
    expect(reconcileWorkflowRun).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('reconcile_started'),
      expect.objectContaining({ runName: 'old-workflow-run' }),
    )
  })

  it('terminalizes a job AgentRun when the Job is missing without stored runner status', async () => {
    const setStatus = vi.fn(async () => undefined)
    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async () => null),
    }
    const reconciler = createAgentRunReconciler(createBaseDependencies({ setStatus }))

    await reconciler.reconcileAgentRun(
      kube as never,
      {
        metadata: {
          name: 'run-1',
          namespace: 'agents',
          generation: 1,
          finalizers: ['agents.proompteng.ai/runtime-cleanup'],
        },
        spec: {
          agentRef: { name: 'codex-agent' },
          runtime: { type: 'job' },
          parameters: {},
          workload: {},
        },
        status: {
          phase: 'Running',
          startedAt: '2026-05-18T13:00:00.000Z',
          runtimeRef: {
            type: 'job',
            name: 'run-1-job',
            namespace: 'agents',
            jobObservedAt: '2026-05-18T13:00:01.000Z',
          },
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

    expect(kube.get).toHaveBeenCalledWith('job', 'run-1-job', 'agents')
    expect(setStatus).toHaveBeenCalledWith(
      kube,
      expect.any(Object),
      expect.objectContaining({
        phase: 'Failed',
        reason: 'JobMissing',
        finishedAt: '2026-05-18T14:00:00.000Z',
        runtimeRef: expect.objectContaining({ type: 'job', name: 'run-1-job' }),
        conditions: expect.arrayContaining([
          expect.objectContaining({ type: 'Warning', status: 'True', reason: 'JobMissing' }),
          expect.objectContaining({ type: 'Failed', status: 'True', reason: 'JobMissing' }),
        ]),
      }),
    )
  })

  it('returns without updating when Job is missing and jobObservedAt is not set', async () => {
    const setStatus = vi.fn(async () => undefined)
    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async () => null),
    }
    const reconciler = createAgentRunReconciler(createBaseDependencies({ setStatus }))

    await reconciler.reconcileAgentRun(
      kube as never,
      {
        metadata: {
          name: 'run-1',
          namespace: 'agents',
          generation: 1,
          finalizers: ['agents.proompteng.ai/runtime-cleanup'],
        },
        spec: {
          agentRef: { name: 'codex-agent' },
          runtime: { type: 'job' },
          parameters: {},
          workload: {},
        },
        status: {
          phase: 'Running',
          startedAt: '2026-05-18T13:00:00.000Z',
          runtimeRef: {
            type: 'job',
            name: 'run-1-job',
            namespace: 'agents',
          },
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

    expect(kube.get).toHaveBeenCalledWith('job', 'run-1-job', 'agents')
    expect(setStatus).not.toHaveBeenCalled()
  })
})
