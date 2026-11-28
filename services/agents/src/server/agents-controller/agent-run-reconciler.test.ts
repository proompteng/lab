import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentRunReconciler, resolveProviderReadinessBlock } from './agent-run-reconciler'
import { normalizeConditions } from './conditions'
import { hashAgentRunImmutableSpec } from './immutable-spec'
import { AGENT_RUN_SPEC_HASH_ANNOTATION, buildRunSpec, makeName } from './job-runtime'
import { PROVIDER_CAPACITY_EXHAUSTED_REASON } from './provider-capacity'
import { isKubeConflict, RESOURCE_MAP } from '../kube-types'
import { AgentRunIndex } from './queue-state'
import { resolveParameters } from './run-utils'
import { createTemporalRuntimeTools } from './temporal-runtime'

describe('agents controller agent-run reconciler', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
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
      new AgentRunIndex(),
      {
        perNamespace: 10,
        perAgent: 10,
        cluster: 10,
        repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
      },
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
      new AgentRunIndex(),
      {
        perNamespace: 10,
        perAgent: 10,
        cluster: 10,
        repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
      },
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
      new AgentRunIndex(),
      {
        perNamespace: 10,
        perAgent: 10,
        cluster: 10,
        repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
      },
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
      new AgentRunIndex(),
      {
        perNamespace: 10,
        perAgent: 10,
        cluster: 10,
        repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
      },
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
        new AgentRunIndex(),
        {
          perNamespace: 10,
          perAgent: 10,
          cluster: 10,
          repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
        },
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
      new AgentRunIndex(),
      {
        perNamespace: 10,
        perAgent: 10,
        cluster: 10,
        repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
      },
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
      new AgentRunIndex(),
      {
        perNamespace: 10,
        perAgent: 10,
        cluster: 10,
        repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
      },
    )

    expect(kube.get).toHaveBeenCalledWith('job', 'run-1-job', 'agents')
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('recovers a custom runtime start on HTTP 409 status conflict without repeating the endpoint POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({ accepted: true, executionId: 'exec-1' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const initialRun = {
      metadata: {
        name: 'custom-run',
        namespace: 'agents',
        uid: 'custom-uid-1',
        generation: 1,
        resourceVersion: '10',
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: {
        agentRef: { name: 'custom-agent' },
        runtime: { type: 'custom', config: { endpoint: 'https://runner.internal/submit' } },
        implementation: { inline: { text: 'Run custom action' } },
        parameters: {},
      },
      status: { phase: 'Pending' },
    }
    const refreshedRun = {
      ...initialRun,
      metadata: {
        ...initialRun.metadata,
        resourceVersion: '11',
        annotations: { 'example.com/updated-in-flight': 'true' },
      },
    }
    const expectedSpecHash = hashAgentRunImmutableSpec(initialRun)

    const setStatus = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('resourceVersion conflict'), { code: 409 }))
      .mockResolvedValueOnce(undefined)

    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async (kind: string, name: string) => {
        if (kind === RESOURCE_MAP.Agent && name === 'custom-agent') {
          return {
            metadata: { name: 'custom-agent' },
            spec: { providerRef: { name: 'custom-provider' }, defaults: { systemPrompt: 'system' } },
          }
        }
        if (kind === RESOURCE_MAP.AgentProvider && name === 'custom-provider') {
          return { metadata: { name: 'custom-provider' }, spec: {} }
        }
        if (kind === RESOURCE_MAP.AgentRun && name === 'custom-run') {
          return refreshedRun
        }
        return null
      }),
    }

    const temporalTools = createTemporalRuntimeTools({
      getTemporalClient: async () => ({}),
      resolveParameters,
      buildRunSpec,
      makeName,
      buildConditions: (resource) =>
        normalizeConditions((resource.status as Record<string, unknown> | undefined)?.conditions),
      nowIso: () => '2026-05-18T14:00:00.000Z',
      setStatus: setStatus as never,
    })

    const reconciler = createAgentRunReconciler(
      createBaseDependencies({
        setStatus,
        submitCustomRun: temporalTools.submitCustomRun,
        buildConditions: (resource) =>
          normalizeConditions((resource.status as Record<string, unknown> | undefined)?.conditions),
      }),
    )

    await reconciler.reconcileAgentRun(kube as never, initialRun, 'agents', [], new AgentRunIndex(), {
      perNamespace: 10,
      perAgent: 10,
      cluster: 10,
      repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(kube.get).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'custom-run', 'agents')
    expect(setStatus).toHaveBeenCalledTimes(2)
    expect(setStatus).toHaveBeenNthCalledWith(
      2,
      kube,
      refreshedRun,
      expect.objectContaining({
        observedGeneration: 1,
        phase: 'Running',
        specHash: expectedSpecHash,
        runtimeRef: {
          type: 'custom',
          name: 'https://runner.internal/submit',
          namespace: 'external',
          response: { accepted: true, executionId: 'exec-1' },
        },
        conditions: expect.arrayContaining([
          expect.objectContaining({ type: 'Accepted', status: 'True', reason: 'Submitted' }),
          expect.objectContaining({ type: 'InProgress', status: 'True', reason: 'Running' }),
        ]),
      }),
    )
  })

  it('recovers a temporal runtime start on HTTP 409 status conflict without repeating workflow.start', async () => {
    const start = vi.fn().mockResolvedValue({
      workflowId: 'temporal-run-temporal',
      namespace: 'temporal',
      runId: 'wf-run-1',
    })
    const temporalClient = {
      workflow: {
        start,
        result: vi.fn(),
        cancel: vi.fn(async () => undefined),
      },
    }

    const initialRun = {
      metadata: {
        name: 'temporal-run',
        namespace: 'agents',
        uid: 'temporal-uid-1',
        generation: 1,
        resourceVersion: '20',
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: {
        agentRef: { name: 'temporal-agent' },
        runtime: {
          type: 'temporal',
          config: { workflowType: 'AgentWorkflow', taskQueue: 'agents-queue', namespace: 'temporal' },
        },
        implementation: { inline: { text: 'Run temporal workflow' } },
        parameters: {},
      },
      status: { phase: 'Pending' },
    }
    const refreshedRun = {
      ...initialRun,
      metadata: {
        ...initialRun.metadata,
        resourceVersion: '21',
        labels: { 'example.com/touched': '1' },
      },
    }
    const expectedSpecHash = hashAgentRunImmutableSpec(initialRun)

    const setStatus = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('resourceVersion conflict'), { code: 409 }))
      .mockResolvedValueOnce(undefined)

    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async (kind: string, name: string) => {
        if (kind === RESOURCE_MAP.Agent && name === 'temporal-agent') {
          return {
            metadata: { name: 'temporal-agent' },
            spec: { providerRef: { name: 'temporal-provider' }, defaults: { systemPrompt: 'system' } },
          }
        }
        if (kind === RESOURCE_MAP.AgentProvider && name === 'temporal-provider') {
          return { metadata: { name: 'temporal-provider' }, spec: {} }
        }
        if (kind === RESOURCE_MAP.AgentRun && name === 'temporal-run') {
          return refreshedRun
        }
        return null
      }),
    }

    const temporalTools = createTemporalRuntimeTools({
      getTemporalClient: async () => temporalClient,
      resolveParameters,
      buildRunSpec,
      makeName,
      buildConditions: (resource) =>
        normalizeConditions((resource.status as Record<string, unknown> | undefined)?.conditions),
      nowIso: () => '2026-05-18T14:00:00.000Z',
      setStatus: setStatus as never,
    })

    const reconciler = createAgentRunReconciler(
      createBaseDependencies({
        setStatus,
        getTemporalClient: async () => temporalClient,
        submitTemporalRun: temporalTools.submitTemporalRun,
        buildConditions: (resource) =>
          normalizeConditions((resource.status as Record<string, unknown> | undefined)?.conditions),
      }),
    )

    await reconciler.reconcileAgentRun(kube as never, initialRun, 'agents', [], new AgentRunIndex(), {
      perNamespace: 10,
      perAgent: 10,
      cluster: 10,
      repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
    })

    expect(start).toHaveBeenCalledTimes(1)
    expect(temporalClient.workflow.cancel).not.toHaveBeenCalled()
    expect(kube.get).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'temporal-run', 'agents')
    expect(setStatus).toHaveBeenCalledTimes(2)
    expect(setStatus).toHaveBeenNthCalledWith(
      2,
      kube,
      refreshedRun,
      expect.objectContaining({
        observedGeneration: 1,
        phase: 'Running',
        specHash: expectedSpecHash,
        runtimeRef: {
          type: 'temporal',
          name: 'temporal-run-temporal',
          namespace: 'temporal',
          workflowId: 'temporal-run-temporal',
          runId: 'wf-run-1',
          taskQueue: 'agents-queue',
        },
      }),
    )
  })

  it('cancels an orphaned temporal start when the refreshed AgentRun transitioned to Cancelled during a 409 conflict', async () => {
    const cancel = vi.fn(async () => undefined)
    const submitTemporalRun = vi.fn(async () => ({
      type: 'temporal',
      name: 'temporal-run-temporal',
      namespace: 'temporal',
      workflowId: 'temporal-run-temporal',
      runId: 'wf-run-2',
      taskQueue: 'agents-queue',
    }))
    const setStatus = vi.fn().mockRejectedValueOnce(Object.assign(new Error('resourceVersion conflict'), { code: 409 }))

    const initialRun = {
      metadata: {
        name: 'temporal-cancelled',
        namespace: 'agents',
        uid: 'temporal-uid-2',
        generation: 1,
        resourceVersion: '30',
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: {
        agentRef: { name: 'temporal-agent' },
        runtime: { type: 'temporal', config: { workflowType: 'AgentWorkflow', taskQueue: 'agents-queue' } },
        implementation: { inline: { text: 'Run temporal workflow' } },
        parameters: {},
      },
      status: { phase: 'Pending' },
    }
    const cancelledRun = {
      ...initialRun,
      metadata: { ...initialRun.metadata, resourceVersion: '31' },
      status: { phase: 'Cancelled', finishedAt: '2026-05-18T14:00:00.000Z' },
    }
    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async (kind: string, name: string) => {
        if (kind === RESOURCE_MAP.Agent) {
          return {
            metadata: { name },
            spec: { providerRef: { name: 'temporal-provider' }, defaults: { systemPrompt: 'system' } },
          }
        }
        if (kind === RESOURCE_MAP.AgentProvider) return { metadata: { name }, spec: {} }
        if (kind === RESOURCE_MAP.AgentRun) return cancelledRun
        return null
      }),
    }

    const reconciler = createAgentRunReconciler(
      createBaseDependencies({
        setStatus,
        submitTemporalRun,
        getTemporalClient: async () => ({ workflow: { cancel } }),
      }),
    )

    await reconciler.reconcileAgentRun(kube as never, initialRun, 'agents', [], new AgentRunIndex(), {
      perNamespace: 10,
      perAgent: 10,
      cluster: 10,
      repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
    })

    expect(submitTemporalRun).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      workflowId: 'temporal-run-temporal',
      runId: 'wf-run-2',
      namespace: 'temporal',
    })
  })

  it('bounds status conflict retries for non-Job runs and avoids bubbling a 409 that would resubmit', async () => {
    const submitCustomRun = vi.fn(async () => ({
      type: 'custom',
      name: 'https://runner.internal/submit',
      namespace: 'external',
      response: { accepted: true },
    }))
    const setStatus = vi.fn(async () => {
      throw Object.assign(new Error('resourceVersion conflict'), { code: 409 })
    })
    let version = 40
    const baseRun = {
      metadata: {
        name: 'custom-busy',
        namespace: 'agents',
        uid: 'custom-uid-busy',
        generation: 1,
        resourceVersion: String(version),
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: {
        agentRef: { name: 'custom-agent' },
        runtime: { type: 'custom', config: { endpoint: 'https://runner.internal/submit' } },
        implementation: { inline: { text: 'Run custom action' } },
        parameters: {},
      },
      status: { phase: 'Pending' },
    }
    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async (kind: string, name: string) => {
        if (kind === RESOURCE_MAP.Agent) {
          return {
            metadata: { name },
            spec: { providerRef: { name: 'custom-provider' }, defaults: { systemPrompt: 'system' } },
          }
        }
        if (kind === RESOURCE_MAP.AgentProvider) return { metadata: { name }, spec: {} }
        if (kind === RESOURCE_MAP.AgentRun) {
          version += 1
          return { ...baseRun, metadata: { ...baseRun.metadata, resourceVersion: String(version) } }
        }
        return null
      }),
    }

    const reconciler = createAgentRunReconciler(
      createBaseDependencies({
        setStatus,
        submitCustomRun,
      }),
    )

    let caught: unknown
    try {
      await reconciler.reconcileAgentRun(kube as never, baseRun, 'agents', [], new AgentRunIndex(), {
        perNamespace: 10,
        perAgent: 10,
        cluster: 10,
        repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('after 6 conflict attempts')
    expect(isKubeConflict(caught)).toBe(false)
    expect(submitCustomRun).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenCalledTimes(6)
  })

  it('restores acceptance specHash from the orphaned Job annotation and enforces immutability on subsequent mutation', async () => {
    const persistedStatuses: Record<string, unknown>[] = []
    const setStatus = vi.fn(async (_kube, _resource, status: Record<string, unknown>) => {
      persistedStatuses.push(status)
    })
    const originalRun = {
      metadata: {
        name: 'adopted-run',
        namespace: 'agents',
        uid: 'adopted-uid-1',
        generation: 1,
        resourceVersion: '50',
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: {
        agentRef: { name: 'codex-agent' },
        runtime: { type: 'job', config: { mode: 'original' } },
        implementation: { inline: { text: 'Original implementation' } },
        secrets: ['secret-a'],
        parameters: {},
        workload: {},
      },
      status: { phase: 'Pending' },
    }
    const originalAcceptanceHash = hashAgentRunImmutableSpec(originalRun)
    const orphanedJob = {
      metadata: {
        name: 'adopted-run-job',
        namespace: 'agents',
        uid: 'adopted-job-uid-1',
        labels: {
          'agents.proompteng.ai/agent-run': 'adopted-run',
          'agents.proompteng.ai/run-uid': 'adopted-uid-1',
        },
        annotations: {
          [AGENT_RUN_SPEC_HASH_ANNOTATION]: originalAcceptanceHash,
        },
      },
      status: { active: 1 },
    }
    const kube = {
      patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      get: vi.fn(async (kind: string, name: string) =>
        kind === 'job' && name === 'adopted-run-job' ? orphanedJob : null,
      ),
    }
    const submitJobRun = vi.fn()
    const reconciler = createAgentRunReconciler(
      createBaseDependencies({
        setStatus,
        submitJobRun,
        buildConditions: (resource) =>
          normalizeConditions((resource.status as Record<string, unknown> | undefined)?.conditions),
      }),
    )

    // Step 1: Initial Running status write was lost; reconciler adopts the orphaned Job and restores status.specHash.
    await reconciler.reconcileAgentRun(kube as never, originalRun, 'agents', [], new AgentRunIndex(), {
      perNamespace: 10,
      perAgent: 10,
      cluster: 10,
      repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
    })

    expect(submitJobRun).not.toHaveBeenCalled()
    expect(persistedStatuses).toHaveLength(1)
    expect(persistedStatuses[0]).toMatchObject({
      phase: 'Running',
      specHash: originalAcceptanceHash,
      runtimeRef: {
        type: 'job',
        name: 'adopted-run-job',
        namespace: 'agents',
        uid: 'adopted-job-uid-1',
      },
      conditions: expect.arrayContaining([
        expect.objectContaining({ type: 'Accepted', status: 'True', reason: 'JobAdopted' }),
      ]),
    })

    // Step 2: Mutate immutable spec fields after adoption; immutability enforcement must reject and cancel the Job.
    const mutatedRun = {
      ...originalRun,
      metadata: { ...originalRun.metadata, generation: 2, resourceVersion: '51' },
      spec: {
        ...originalRun.spec,
        implementation: { inline: { text: 'Tampered implementation' } },
        secrets: ['secret-a', 'secret-b'],
      },
      status: persistedStatuses[0],
    }

    await reconciler.reconcileAgentRun(kube as never, mutatedRun, 'agents', [], new AgentRunIndex(), {
      perNamespace: 10,
      perAgent: 10,
      cluster: 10,
      repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
    })

    expect(kube.delete).toHaveBeenCalledWith('job', 'adopted-run-job', 'agents', { wait: false })
    expect(persistedStatuses).toHaveLength(2)
    expect(persistedStatuses[1]).toMatchObject({
      phase: 'Failed',
      conditions: expect.arrayContaining([
        expect.objectContaining({ type: 'Failed', status: 'True', reason: 'SpecImmutableViolation' }),
      ]),
    })
  })

  it('falls back to hashing the current spec when adopting a legacy orphaned Job without a spec-hash annotation', async () => {
    const setStatus = vi.fn(async () => undefined)
    const run = {
      metadata: {
        name: 'legacy-adopted',
        namespace: 'agents',
        uid: 'legacy-uid-1',
        generation: 1,
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: {
        agentRef: { name: 'codex-agent' },
        runtime: { type: 'job' },
        implementation: { inline: { text: 'Legacy implementation' } },
        parameters: {},
        workload: {},
      },
      status: { phase: 'Pending' },
    }
    const legacyOrphanedJob = {
      metadata: {
        name: 'legacy-adopted-job',
        namespace: 'agents',
        uid: 'legacy-job-uid-1',
        labels: {
          'agents.proompteng.ai/agent-run': 'legacy-adopted',
          'agents.proompteng.ai/run-uid': 'legacy-uid-1',
        },
      },
      status: { active: 1 },
    }
    const kube = {
      patch: vi.fn(async () => ({})),
      get: vi.fn(async (kind: string, name: string) =>
        kind === 'job' && name === 'legacy-adopted-job' ? legacyOrphanedJob : null,
      ),
    }

    const reconciler = createAgentRunReconciler(createBaseDependencies({ setStatus }))

    await reconciler.reconcileAgentRun(kube as never, run, 'agents', [], new AgentRunIndex(), {
      perNamespace: 10,
      perAgent: 10,
      cluster: 10,
      repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map() },
    })

    expect(setStatus).toHaveBeenCalledWith(
      kube,
      run,
      expect.objectContaining({
        phase: 'Running',
        specHash: hashAgentRunImmutableSpec(run),
      }),
    )
  })
})
