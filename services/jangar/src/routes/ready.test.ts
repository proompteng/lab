import { beforeEach, describe, expect, it, vi } from 'vitest'

const agentsControllerMocks = vi.hoisted(() => ({
  getAgentsControllerHealth: vi.fn(),
  assessAgentRunIngestion: vi.fn(),
}))

const leaderElectionMocks = vi.hoisted(() => ({
  getLeaderElectionStatus: vi.fn(),
}))

const orchestrationControllerMocks = vi.hoisted(() => ({
  getOrchestrationControllerHealth: vi.fn(),
}))

const supportingControllerMocks = vi.hoisted(() => ({
  getSupportingControllerHealth: vi.fn(),
}))

const controlPlaneStatusMocks = vi.hoisted(() => ({
  buildExecutionTrust: vi.fn(),
}))

const runtimeAdmissionMocks = vi.hoisted(() => ({
  buildRuntimeAdmissionSnapshot: vi.fn(),
  findAdmissionPassport: vi.fn(),
}))

const memoryProviderHealthMocks = vi.hoisted(() => ({
  getMemoryProviderHealth: vi.fn(),
}))

vi.mock('~/server/agents-controller', () => agentsControllerMocks)
vi.mock('~/server/leader-election', () => leaderElectionMocks)
vi.mock('~/server/orchestration-controller', () => orchestrationControllerMocks)
vi.mock('~/server/supporting-primitives-controller', () => supportingControllerMocks)
vi.mock('~/server/memory-provider-health', () => memoryProviderHealthMocks)
vi.mock('~/server/control-plane-status', async () => {
  const actual = await vi.importActual<typeof import('~/server/control-plane-status')>('~/server/control-plane-status')
  return {
    ...actual,
    buildExecutionTrust: controlPlaneStatusMocks.buildExecutionTrust,
  }
})
vi.mock('~/server/control-plane-runtime-admission', () => runtimeAdmissionMocks)

const buildRuntimeKit = (overrides: Record<string, unknown> = {}) => ({
  runtime_kit_id: 'runtime-kit:serving:1',
  kit_class: 'serving',
  subject_ref: 'jangar:/ready',
  image_ref: 'runtime:local',
  workspace_contract_version: 'shadow-v1',
  component_digest: 'digest-serving',
  decision: 'healthy',
  observed_at: '2026-03-08T21:00:00Z',
  fresh_until: '2026-03-08T21:05:00Z',
  producer_revision: 'shadow-v1',
  reason_codes: [],
  components: [],
  ...overrides,
})

const buildAdmissionPassport = (overrides: Record<string, unknown> = {}) => ({
  admission_passport_id: 'passport:serving:1',
  consumer_class: 'serving',
  authority_session_id: 'authority-session:1',
  recovery_case_set_digest: 'recovery-1',
  runtime_kit_set_digest: 'runtime-1',
  decision: 'allow',
  reason_codes: [],
  required_subjects: [],
  required_runtime_kits: ['runtime-kit:serving:1'],
  issued_at: '2026-03-08T21:00:00Z',
  fresh_until: '2026-03-08T21:05:00Z',
  producer_revision: 'shadow-v1',
  ...overrides,
})

const buildRuntimeAdmissionSnapshot = (
  overrides: Partial<{
    runtimeKits: Array<Record<string, unknown>>
    admissionPassports: Array<Record<string, unknown>>
    servingPassportId: string | null
  }> = {},
) => ({
  runtimeKits: overrides.runtimeKits ?? [
    buildRuntimeKit(),
    buildRuntimeKit({
      runtime_kit_id: 'runtime-kit:collaboration:1',
      kit_class: 'collaboration',
      subject_ref: 'jangar:codex:huly-collaboration',
      component_digest: 'digest-collaboration',
    }),
  ],
  admissionPassports: overrides.admissionPassports ?? [
    buildAdmissionPassport(),
    buildAdmissionPassport({
      admission_passport_id: 'passport:swarm_implement:1',
      consumer_class: 'swarm_implement',
      runtime_kit_set_digest: 'runtime-2',
      required_runtime_kits: ['runtime-kit:collaboration:1'],
    }),
  ],
  servingPassportId: overrides.servingPassportId ?? 'passport:serving:1',
})

describe('getReadyHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    controlPlaneStatusMocks.buildExecutionTrust.mockReset()
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReset()
    runtimeAdmissionMocks.findAdmissionPassport.mockReset()
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'healthy',
        reason: 'execution trust is healthy.',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [],
        evidence_summary: [],
      },
      swarms: [],
      stages: [],
    })
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(buildRuntimeAdmissionSnapshot())
    runtimeAdmissionMocks.findAdmissionPassport.mockImplementation(({ admissionPassports, consumerClass }) =>
      admissionPassports.find((passport: { consumer_class?: string }) => passport.consumer_class === consumerClass),
    )
    memoryProviderHealthMocks.getMemoryProviderHealth.mockReturnValue({
      status: 'healthy',
      reason: 'memory embeddings configured for an explicit OpenAI-compatible endpoint',
      mode: 'self-hosted',
      fallbackActive: false,
      config: {
        apiBaseUrl: 'http://saigak.jangar.svc.cluster.local:11434/v1',
        model: 'qwen3-embedding-saigak:8b',
        dimension: 1024,
        timeoutMs: 15000,
        maxInputChars: 60000,
        hosted: false,
      },
    })

    agentsControllerMocks.getAgentsControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
      agentRunIngestion: [],
    })
    agentsControllerMocks.assessAgentRunIngestion.mockReturnValue({
      namespace: 'agents',
      status: 'healthy',
      message: 'AgentRun ingestion healthy',
      dispatchPaused: false,
      lastWatchEventAt: '2026-03-08T21:00:00Z',
      lastResyncAt: '2026-03-08T21:00:00Z',
      untouchedRunCount: 0,
      oldestUntouchedAgeSeconds: null,
    })
    leaderElectionMocks.getLeaderElectionStatus.mockReturnValue({
      enabled: true,
      required: true,
      isLeader: true,
      leaseName: 'jangar-controller-leader',
      leaseNamespace: 'agents',
      identity: 'agents-controllers-1',
      lastTransitionAt: '2026-03-08T21:00:00Z',
      lastAttemptAt: '2026-03-08T21:00:00Z',
      lastSuccessAt: '2026-03-08T21:00:00Z',
      lastError: null,
    })
    orchestrationControllerMocks.getOrchestrationControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
    })
    supportingControllerMocks.getSupportingControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
    })
  })

  it('returns 200 when leader is ready and AgentRun ingestion is healthy', async () => {
    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.memory_provider).toMatchObject({
      status: 'healthy',
    })
  })

  it('returns 200 and exposes a serving passport when only collaboration runtime debt is blocked', async () => {
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        runtimeKits: [
          buildRuntimeKit(),
          buildRuntimeKit({
            runtime_kit_id: 'runtime-kit:collaboration:2',
            kit_class: 'collaboration',
            subject_ref: 'jangar:codex:huly-collaboration',
            component_digest: 'digest-collaboration-2',
            decision: 'blocked',
            reason_codes: ['runtime_kit_component_missing:huly_api_script'],
          }),
        ],
        admissionPassports: [
          buildAdmissionPassport(),
          buildAdmissionPassport({
            admission_passport_id: 'passport:swarm_implement:2',
            consumer_class: 'swarm_implement',
            runtime_kit_set_digest: 'runtime-2',
            decision: 'block',
            reason_codes: ['runtime_kit_component_missing:huly_api_script'],
            required_runtime_kits: ['runtime-kit:collaboration:2'],
          }),
        ],
      }),
    )

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.serving_passport_id).toBe('passport:serving:1')
    expect(body.runtime_kits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kit_class: 'collaboration',
          decision: 'blocked',
        }),
      ]),
    )
  })

  it('returns 503 when AgentRun ingestion is degraded', async () => {
    agentsControllerMocks.assessAgentRunIngestion.mockReturnValue({
      namespace: 'agents',
      status: 'degraded',
      message: 'untouched AgentRuns detected for 180s',
      dispatchPaused: true,
      lastWatchEventAt: null,
      lastResyncAt: '2026-03-08T21:00:00Z',
      untouchedRunCount: 3,
      oldestUntouchedAgeSeconds: 180,
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
  })

  it('returns 200 when leader election is required but this instance is a healthy standby', async () => {
    leaderElectionMocks.getLeaderElectionStatus.mockReturnValue({
      enabled: true,
      required: true,
      isLeader: false,
      leaseName: 'jangar-controller-leader',
      leaseNamespace: 'agents',
      identity: 'agents-controllers-2',
      lastTransitionAt: '2026-03-08T21:00:00Z',
      lastAttemptAt: '2026-03-08T21:00:00Z',
      lastSuccessAt: '2026-03-08T21:00:00Z',
      lastError: null,
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
  })

  it('returns 503 when leader election is required but standby has not observed a healthy lease attempt', async () => {
    leaderElectionMocks.getLeaderElectionStatus.mockReturnValue({
      enabled: true,
      required: true,
      isLeader: false,
      leaseName: 'jangar-controller-leader',
      leaseNamespace: 'agents',
      identity: 'agents-controllers-2',
      lastTransitionAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: 'lease watch failed',
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
  })

  it('returns 200 when execution trust is healthy', async () => {
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'healthy',
        reason: 'execution trust is healthy.',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [],
        evidence_summary: [],
      },
      swarms: [],
      stages: [],
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.execution_trust).toMatchObject({
      status: 'healthy',
    })
  })

  it('returns 200 when execution trust is degraded', async () => {
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'degraded',
        reason: 'execution trust degraded while freeze expiry repair is in progress',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [
          {
            type: 'swarms',
            scope: 'agents',
            name: 'jangar-control-plane',
            reason: 'freeze expiry unreconciled (StageStaleness)',
            class: 'degraded',
          },
        ],
        evidence_summary: ['freeze expiry unreconciled (StageStaleness)'],
      },
      swarms: [],
      stages: [],
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.execution_trust).toMatchObject({
      status: 'degraded',
    })
  })

  it('returns 503 when execution trust is blocked', async () => {
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        admissionPassports: [
          buildAdmissionPassport({
            admission_passport_id: 'passport:serving:blocked',
            decision: 'block',
            reason_codes: ['execution_trust_blocked'],
          }),
        ],
        servingPassportId: 'passport:serving:blocked',
      }),
    )
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'blocked',
        reason: 'execution trust blocked by stage staleness',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [
          {
            type: 'swarms',
            scope: 'agents',
            name: 'jangar-control-plane',
            reason: 'requirements stalled',
            class: 'blocked',
          },
        ],
        evidence_summary: ['execution trust blocked'],
      },
      swarms: [],
      stages: [],
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'blocked',
    })
  })

  it('returns 503 when the serving passport is blocked', async () => {
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        admissionPassports: [
          buildAdmissionPassport({
            admission_passport_id: 'passport:serving:2',
            decision: 'block',
            reason_codes: ['runtime_kit_component_missing:serving_runtime_binary'],
          }),
        ],
        servingPassportId: 'passport:serving:2',
      }),
    )

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.serving_passport_id).toBe('passport:serving:2')
  })

  it('returns 503 when any watched namespace reports blocked execution trust', async () => {
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        admissionPassports: [
          buildAdmissionPassport({
            admission_passport_id: 'passport:serving:blocked',
            decision: 'block',
            reason_codes: ['execution_trust_blocked'],
          }),
        ],
        servingPassportId: 'passport:serving:blocked',
      }),
    )
    agentsControllerMocks.getAgentsControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents', 'staging'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
      agentRunIngestion: [],
    })
    controlPlaneStatusMocks.buildExecutionTrust
      .mockResolvedValueOnce({
        executionTrust: {
          status: 'healthy',
          reason: 'execution trust is healthy.',
          last_evaluated_at: '2026-03-08T21:00:00Z',
          blocking_windows: [],
          evidence_summary: [],
        },
        swarms: [],
        stages: [],
      })
      .mockResolvedValueOnce({
        executionTrust: {
          status: 'blocked',
          reason: 'execution trust blocked by stage staleness',
          last_evaluated_at: '2026-03-08T21:00:00Z',
          blocking_windows: [
            {
              type: 'swarms',
              scope: 'staging',
              name: 'torghut-quant',
              reason: 'requirements stalled',
              class: 'blocked',
            },
          ],
          evidence_summary: ['execution trust blocked'],
        },
        swarms: [],
        stages: [],
      })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenCalledTimes(2)
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        namespace: 'agents',
      }),
    )
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        namespace: 'staging',
      }),
    )
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'blocked',
    })
    expect(body.execution_trust.reason).toContain('2 namespaces')
    expect(body.execution_trust.blocking_windows).toEqual([
      expect.objectContaining({
        scope: 'staging',
        class: 'blocked',
      }),
    ])
  })

  it('returns 503 when execution trust evaluation fails', async () => {
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        admissionPassports: [
          buildAdmissionPassport({
            admission_passport_id: 'passport:serving:unknown',
            decision: 'block',
            reason_codes: ['execution_trust_unknown'],
          }),
        ],
        servingPassportId: 'passport:serving:unknown',
      }),
    )
    controlPlaneStatusMocks.buildExecutionTrust.mockRejectedValue(new Error('trust fetch failed'))
    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'unknown',
    })
    expect(body.execution_trust.reason).toContain('execution trust check failed for namespace agents')
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenCalledTimes(1)
  })

  it('returns 503 when memory provider health is blocked', async () => {
    memoryProviderHealthMocks.getMemoryProviderHealth.mockReturnValue({
      status: 'blocked',
      reason:
        'missing OPENAI_API_KEY; set it or point OPENAI_EMBEDDING_API_BASE_URL/OPENAI_API_BASE_URL at an OpenAI-compatible endpoint',
      mode: 'hosted',
      fallbackActive: false,
      config: {
        apiBaseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-3-small',
        dimension: 1536,
        timeoutMs: 15000,
        maxInputChars: 60000,
        hosted: true,
      },
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.memory_provider).toMatchObject({
      status: 'blocked',
    })
  })
})
