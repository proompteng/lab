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

const watchReliabilityMocks = vi.hoisted(() => ({
  getWatchReliabilitySummary: vi.fn(),
}))

const metricsMocks = vi.hoisted(() => ({
  getMetricsSinkPressureSummary: vi.fn(),
}))

const githubReviewIngestMocks = vi.hoisted(() => ({
  getGithubReviewIngestPressureSummary: vi.fn(),
}))

vi.mock('~/server/agents-controller', () => agentsControllerMocks)
vi.mock('~/server/leader-election', () => leaderElectionMocks)
vi.mock('~/server/orchestration-controller', () => orchestrationControllerMocks)
vi.mock('~/server/supporting-primitives-controller', () => supportingControllerMocks)
vi.mock('~/server/memory-provider-health', () => memoryProviderHealthMocks)
vi.mock('~/server/control-plane-watch-reliability', () => watchReliabilityMocks)
vi.mock('~/server/metrics', () => metricsMocks)
vi.mock('~/server/github-review-ingest', () => githubReviewIngestMocks)
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

const buildRecoveryWarrant = (overrides: Record<string, unknown> = {}) => ({
  recovery_warrant_id: 'recovery-warrant:serving:1',
  recovery_epoch_id: 'recovery-epoch:serving:1',
  swarm_name: 'jangar-control-plane',
  execution_class: 'serving',
  admitted_revision: 'shadow-v1',
  admitted_image_digest: null,
  runtime_kit_digest: 'runtime-1',
  admission_passport_id: 'passport:serving:1',
  required_proof_cell_ids: ['runtime-proof-cell:serving:1'],
  active_backlog_seat_count: 0,
  projection_watermark_ids: ['projection-watermark:ready:1'],
  status: 'sealed',
  opened_at: '2026-03-08T21:00:00Z',
  sealed_at: '2026-03-08T21:00:00Z',
  superseded_at: null,
  reason_codes: [],
  ...overrides,
})

const buildRuntimeProofCell = (overrides: Record<string, unknown> = {}) => ({
  runtime_proof_cell_id: 'runtime-proof-cell:serving:1',
  recovery_warrant_id: 'recovery-warrant:serving:1',
  runtime_kit_id: 'runtime-kit:serving:1',
  proof_kind: 'runtime_kit',
  proof_subject: 'runtime-kit:serving:1',
  expected_ref: 'digest-serving',
  observed_ref: 'healthy',
  artifact_ref: 'jangar:/ready',
  content_hash: 'digest-serving',
  status: 'healthy',
  required: true,
  reason_codes: [],
  observed_at: '2026-03-08T21:00:00Z',
  expires_at: '2026-03-08T21:05:00Z',
  ...overrides,
})

const buildProjectionWatermark = (overrides: Record<string, unknown> = {}) => ({
  projection_watermark_id: 'projection-watermark:ready:1',
  consumer_key: 'jangar_ready',
  recovery_warrant_id: 'recovery-warrant:serving:1',
  projection_digest: 'projection-digest-1',
  source_ref: 'admission-passport:passport:serving:1',
  observed_at: '2026-03-08T21:00:00Z',
  expires_at: '2026-03-08T21:05:00Z',
  status: 'fresh',
  reason_codes: [],
  ...overrides,
})

const buildRuntimeAdmissionSnapshot = (
  overrides: Partial<{
    runtimeKits: Array<Record<string, unknown>>
    admissionPassports: Array<Record<string, unknown>>
    servingPassportId: string | null
    recoveryWarrants: Array<Record<string, unknown>>
    runtimeProofCells: Array<Record<string, unknown>>
    projectionWatermarks: Array<Record<string, unknown>>
  }> = {},
) => ({
  runtimeKits: overrides.runtimeKits ?? [
    buildRuntimeKit(),
    buildRuntimeKit({
      runtime_kit_id: 'runtime-kit:collaboration:1',
      kit_class: 'collaboration',
      subject_ref: 'jangar:codex:nats-collaboration',
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
  recoveryWarrants: overrides.recoveryWarrants ?? [
    buildRecoveryWarrant(),
    buildRecoveryWarrant({
      recovery_warrant_id: 'recovery-warrant:implement:1',
      execution_class: 'implement',
      runtime_kit_digest: 'runtime-2',
      admission_passport_id: 'passport:swarm_implement:1',
      required_proof_cell_ids: ['runtime-proof-cell:implement:1'],
      projection_watermark_ids: ['projection-watermark:status:1'],
    }),
  ],
  runtimeProofCells: overrides.runtimeProofCells ?? [
    buildRuntimeProofCell(),
    buildRuntimeProofCell({
      runtime_proof_cell_id: 'runtime-proof-cell:implement:1',
      recovery_warrant_id: 'recovery-warrant:implement:1',
      runtime_kit_id: 'runtime-kit:collaboration:1',
      proof_subject: 'runtime-kit:collaboration:1',
      expected_ref: 'digest-collaboration',
      content_hash: 'digest-collaboration',
      artifact_ref: 'jangar:codex:nats-collaboration',
    }),
  ],
  projectionWatermarks: overrides.projectionWatermarks ?? [
    buildProjectionWatermark(),
    buildProjectionWatermark({
      projection_watermark_id: 'projection-watermark:status:1',
      consumer_key: 'control_plane_status',
      recovery_warrant_id: 'recovery-warrant:implement:1',
      source_ref: 'admission-passport:passport:swarm_implement:1',
    }),
  ],
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
        dimension: 4096,
        timeoutMs: 15000,
        maxInputChars: 60000,
        hosted: false,
      },
    })
    watchReliabilityMocks.getWatchReliabilitySummary.mockReturnValue({
      status: 'healthy',
      window_minutes: 15,
      observed_streams: 1,
      total_events: 8,
      total_errors: 0,
      total_restarts: 0,
      streams: [
        {
          resource: 'agentruns.agents.proompteng.ai',
          namespace: 'agents',
          events: 8,
          errors: 0,
          restarts: 0,
          last_seen_at: '2026-03-08T21:00:00Z',
        },
      ],
    })
    metricsMocks.getMetricsSinkPressureSummary.mockReturnValue({
      status: 'healthy',
      endpoint: 'http://mimir/otlp/v1/metrics',
      message: 'metrics sink configured',
      reason_codes: [],
    })
    githubReviewIngestMocks.getGithubReviewIngestPressureSummary.mockReturnValue({
      status: 'healthy',
      active_missing_ref_suppressions: 0,
      reason_codes: [],
      message: 'github review ingest healthy',
      evidence_refs: [],
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
    expect(body.repair_bid_admission).toMatchObject({
      schema_version: 'jangar.repair-bid-admission-state.v1',
      mode: 'observe',
      torghut_settlement_ledger_ref: null,
    })
    expect(body.repair_bid_admission.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'serve_readonly',
          decision: 'allow',
        }),
        expect.objectContaining({
          action_class: 'dispatch_normal',
          decision: 'hold',
        }),
      ]),
    )
    expect(body.evidence_pressure_ledger).toMatchObject({
      schema_version: 'jangar.evidence-pressure-ledger.v1',
      evidence_mode: 'observe',
      watch_backoff_policy: {
        state: 'calm',
      },
      scheduler_handoff: {
        status: 'allow',
      },
    })
    expect(body.serving_recovery_warrant_id).toBe('recovery-warrant:serving:1')
    expect(body.serving_runtime_proof_cells_healthy).toBe(true)
  })

  it('returns 200 and exposes a serving passport when only collaboration runtime debt is blocked', async () => {
    runtimeAdmissionMocks.buildRuntimeAdmissionSnapshot.mockReturnValue(
      buildRuntimeAdmissionSnapshot({
        runtimeKits: [
          buildRuntimeKit(),
          buildRuntimeKit({
            runtime_kit_id: 'runtime-kit:collaboration:2',
            kit_class: 'collaboration',
            subject_ref: 'jangar:codex:nats-collaboration',
            component_digest: 'digest-collaboration-2',
            decision: 'blocked',
            reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
          }),
        ],
        admissionPassports: [
          buildAdmissionPassport(),
          buildAdmissionPassport({
            admission_passport_id: 'passport:swarm_implement:2',
            consumer_class: 'swarm_implement',
            runtime_kit_set_digest: 'runtime-2',
            decision: 'block',
            reason_codes: ['runtime_kit_component_missing:codex_nats_publish'],
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
    expect(body.serving_recovery_warrant_id).toBe('recovery-warrant:serving:1')
    expect(body.serving_runtime_proof_cells_healthy).toBe(true)
    expect(body.runtime_kits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kit_class: 'collaboration',
          decision: 'blocked',
        }),
      ]),
    )
  })

  it('returns 200 with degraded status when AgentRun ingestion is degraded', async () => {
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

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
  })

  it('returns 200 with degraded status when the active controller is still adopting backlog', async () => {
    agentsControllerMocks.getAgentsControllerHealth.mockReturnValue({
      enabled: true,
      started: false,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
      agentRunIngestion: [
        {
          namespace: 'agents',
          lastWatchEventAt: '2026-03-08T21:01:00Z',
          lastResyncAt: '2026-03-08T21:00:00Z',
          untouchedRunCount: 12,
          oldestUntouchedAgeSeconds: 4_769_263,
        },
      ],
    })
    agentsControllerMocks.assessAgentRunIngestion.mockReturnValue({
      namespace: 'agents',
      status: 'unknown',
      message: 'agents controller not started',
      dispatchPaused: false,
      lastWatchEventAt: '2026-03-08T21:01:00Z',
      lastResyncAt: '2026-03-08T21:00:00Z',
      untouchedRunCount: 12,
      oldestUntouchedAgeSeconds: 4_769_263,
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.agentsController).toMatchObject({
      started: false,
      crdsReady: true,
    })
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

  it('returns 200 with degraded status when execution trust is blocked', async () => {
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

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'blocked',
    })
  })

  it('returns 200 with degraded status when the serving passport is blocked', async () => {
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

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.serving_passport_id).toBe('passport:serving:2')
  })

  it('returns 200 with degraded status when any watched namespace reports blocked execution trust', async () => {
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

    expect(response.status).toBe(200)
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

  it('returns 200 with degraded status when execution trust evaluation fails', async () => {
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

    expect(response.status).toBe(200)
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
