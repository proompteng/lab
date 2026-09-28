import { Context, Data, Effect, Layer } from 'effect'

import {
  buildAuthorityProvenanceSettlement,
  buildControlPlaneControllerIngestionSettlement,
} from '@proompteng/agent-contracts'
import type { ExecutionTrustStatus } from '@proompteng/agent-contracts'
import { buildControllerWitnessQuorum } from '@proompteng/agent-contracts'
import { assessAgentRunIngestion, getAgentsControllerHealth, type AgentsControllerHealth } from './agents-controller'
import { buildRuntimeAdmissionSnapshot } from './control-plane-runtime-admission'
import type { GrpcStatus } from './control-plane-grpc'
import { resolveGrpcStatus } from './control-plane-grpc'
import {
  createControlPlaneRuntimeEvidenceService,
  type ControlPlaneRuntimeEvidence,
  type WorkflowsReliabilityStatus,
} from './control-plane-runtime-evidence'
import { createControlPlaneWatchReliabilityService } from './control-plane-watch-reliability'
import type {
  AgentsControlPlaneStatus,
  ComponentStatus,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  ControllerStatus,
  HeartbeatAuthoritySource,
  RuntimeAdapterStatus,
} from './control-plane-status-contract'
import { getLeaderElectionStatus, type LeaderElectionStatus } from './leader-election'
import { getOrchestrationControllerHealth } from './orchestration-controller'
import { resolveRuntimeServiceName } from './runtime-identity'
import { getSupportingControllerHealth } from './supporting-primitives-controller'

type ControllerHealthSnapshot = {
  enabled: boolean
  started: boolean
  namespaces?: string[] | null
  crdsReady: boolean | null
  missingCrds: string[]
  forbiddenCrds?: string[]
  lastCheckedAt: string | null
}

type EnvSource = Record<string, string | undefined>

export type {
  AgentsControlPlaneStatus,
  ComponentStatus,
  ControlPlaneControllerWitnessQuorum,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  ControllerStatus,
  HeartbeatAuthoritySource,
  RuntimeAdapterStatus,
} from './control-plane-status-contract'

export class AgentsControlPlaneStatusError extends Data.TaggedError('AgentsControlPlaneStatusError')<{
  readonly operation: string
  readonly message: string
}> {}

export const describeAgentsControlPlaneStatusError = (error: unknown) => {
  if (error instanceof AgentsControlPlaneStatusError) return error.message
  return error instanceof Error ? error.message : String(error)
}

export const agentsControlPlaneStatusErrorDetails = (
  error: unknown,
  details: Record<string, unknown> = {},
): Record<string, unknown> => {
  if (error instanceof AgentsControlPlaneStatusError) {
    return {
      ...details,
      operation: error.operation,
    }
  }
  return details
}

export type BuildAgentsControlPlaneStatusInput = {
  namespace: string
  grpc: GrpcStatus
  service?: string
  now?: Date
  env?: EnvSource
  runtimeEvidence?: ControlPlaneRuntimeEvidence
  watchReliability?: ControlPlaneWatchReliability
  executionTrust?: ExecutionTrustStatus
}

export type GetAgentsControlPlaneStatusInput = Omit<BuildAgentsControlPlaneStatusInput, 'grpc'> & {
  grpc?: GrpcStatus
}

export type AgentsControlPlaneStatusDependencies = {
  now?: () => Date
  env?: EnvSource
  resolveGrpcStatus?: () => Promise<GrpcStatus>
  getLeaderElectionStatus?: () => LeaderElectionStatus
  getAgentsControllerHealth?: () => AgentsControllerHealth
  getOrchestrationControllerHealth?: () => ControllerHealthSnapshot
  getSupportingControllerHealth?: () => ControllerHealthSnapshot
  assessAgentRunIngestion?: typeof assessAgentRunIngestion
  collectRuntimeEvidence?: (input: {
    namespace: string
    now: Date
    env: EnvSource
  }) => Effect.Effect<ControlPlaneRuntimeEvidence, AgentsControlPlaneStatusError>
  collectWatchReliability?: (input: {
    namespace: string
    now: Date
    env: EnvSource
  }) => Effect.Effect<ControlPlaneWatchReliability, AgentsControlPlaneStatusError>
}

export type AgentsControlPlaneStatusService = {
  get: (
    input: GetAgentsControlPlaneStatusInput,
  ) => Effect.Effect<AgentsControlPlaneStatus, AgentsControlPlaneStatusError>
}

export class AgentsControlPlaneStatusApi extends Context.Tag('AgentsControlPlaneStatusApi')<
  AgentsControlPlaneStatusApi,
  AgentsControlPlaneStatusService
>() {}

const runtimeEvidenceUnavailableMessage = 'runtime evidence collection is not available'

const buildAuthority = (namespace: string, now: Date, message: string): HeartbeatAuthoritySource => ({
  mode: 'local',
  namespace,
  source_deployment: '',
  source_pod: '',
  observed_at: now.toISOString(),
  fresh: true,
  message,
})

const resolveControllerStatus = (health: ControllerHealthSnapshot): ComponentStatus => {
  if (!health.enabled) return 'disabled'
  if (health.started && health.crdsReady !== false) return 'healthy'
  if (health.crdsReady === false) return 'degraded'
  return 'unknown'
}

const resolveControllerMessage = (health: ControllerHealthSnapshot) => {
  if (!health.enabled) return 'disabled'
  if (health.crdsReady === false && health.forbiddenCrds?.length) {
    return `insufficient RBAC for CRDs: ${health.forbiddenCrds.join(', ')}`
  }
  if (health.crdsReady === false) return `missing CRDs: ${health.missingCrds.join(', ')}`
  if (!health.started) return 'controller not started'
  return ''
}

const buildControllerStatus = (
  name: string,
  health: ControllerHealthSnapshot,
  namespace: string,
  now: Date,
): ControllerStatus => ({
  name,
  enabled: health.enabled,
  started: health.started,
  scope_namespaces: health.namespaces ?? [],
  crds_ready: health.crdsReady === true,
  missing_crds: health.missingCrds,
  forbidden_crds: health.forbiddenCrds ?? [],
  last_checked_at: health.lastCheckedAt ?? '',
  status: resolveControllerStatus(health),
  message: resolveControllerMessage(health),
  authority: buildAuthority(namespace, now, `${name} local controller state`),
})

const buildLeaderElectionStatus = (leaderElection: LeaderElectionStatus) => ({
  enabled: leaderElection.enabled,
  required: leaderElection.required,
  is_leader: leaderElection.isLeader,
  lease_name: leaderElection.leaseName,
  lease_namespace: leaderElection.leaseNamespace,
  identity: leaderElection.identity,
  last_transition_at: leaderElection.lastTransitionAt ?? '',
  last_attempt_at: leaderElection.lastAttemptAt ?? '',
  last_success_at: leaderElection.lastSuccessAt ?? '',
  last_error: leaderElection.lastError ?? '',
})

const resolveRuntimeAdapterComponentStatus = (controller: ControllerStatus): ComponentStatus | 'configured' => {
  if (controller.status === 'healthy') return 'healthy'
  if (controller.status === 'disabled') return 'disabled'
  return 'unknown'
}

const buildRuntimeAdapterStatus = (
  name: string,
  controller: ControllerStatus,
  namespace: string,
  now: Date,
): RuntimeAdapterStatus => ({
  name,
  available: controller.status === 'healthy',
  status: resolveRuntimeAdapterComponentStatus(controller),
  message: controller.status === 'healthy' ? `${name} runtime via Kubernetes Jobs` : `${name} runtime unavailable`,
  endpoint: '',
  authority: buildAuthority(namespace, now, `${name} runtime derived from local controller state`),
})

const buildDatabaseStatus = (env: EnvSource) => {
  const configured = Boolean(env.DATABASE_URL)
  return {
    configured,
    connected: false,
    status: configured ? ('unknown' as const) : ('disabled' as const),
    message: configured ? 'database connectivity is reported by API calls' : 'DATABASE_URL is not set',
    latency_ms: 0,
    migration_consistency: {
      status: 'unknown' as const,
      migration_table: null,
      registered_count: 0,
      applied_count: 0,
      unapplied_count: 0,
      unexpected_count: 0,
      latest_registered: null,
      latest_applied: null,
      missing_migrations: [],
      unexpected_migrations: [],
      message: 'migration consistency is not evaluated by the generic status builder',
    },
  }
}

const buildAgentRunIngestionStatus = (
  namespace: string,
  health: AgentsControllerHealth,
  deps: Pick<AgentsControlPlaneStatusDependencies, 'assessAgentRunIngestion'>,
) => {
  const assessment = (deps.assessAgentRunIngestion ?? assessAgentRunIngestion)(namespace, health)
  return {
    namespace,
    status: assessment.status,
    message: assessment.message,
    last_watch_event_at: assessment.lastWatchEventAt,
    last_resync_at: assessment.lastResyncAt,
    untouched_run_count: assessment.untouchedRunCount,
    oldest_untouched_age_seconds: assessment.oldestUntouchedAgeSeconds,
  }
}

const unknownWorkflows = (): WorkflowsReliabilityStatus => ({
  active_job_runs: 0,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  window_minutes: 0,
  top_failure_reasons: [],
  data_confidence: 'unknown',
  collection_errors: 0,
  collected_namespaces: 0,
  target_namespaces: 1,
  message: runtimeEvidenceUnavailableMessage,
})

const unknownRolloutHealth = (): ControlPlaneRolloutHealth => ({
  status: 'unknown',
  observed_deployments: 0,
  degraded_deployments: 0,
  deployments: [],
  message: runtimeEvidenceUnavailableMessage,
})

const unknownWatchReliability = (): ControlPlaneWatchReliability => ({
  status: 'unknown',
  window_minutes: 0,
  observed_streams: 0,
  total_events: 0,
  total_errors: 0,
  total_restarts: 0,
  streams: [],
})

const assumedHealthyExecutionTrust = (now: Date): ExecutionTrustStatus => ({
  status: 'healthy',
  reason: 'execution trust assumed healthy for local status compilation',
  last_evaluated_at: now.toISOString(),
  blocking_windows: [],
  evidence_summary: [],
})

const buildDegradedComponents = (input: {
  controllers: ControllerStatus[]
  runtimeAdapters: RuntimeAdapterStatus[]
  grpc: GrpcStatus
  agentRunIngestion: AgentsControlPlaneStatus['agentrun_ingestion']
  watchReliability: ControlPlaneWatchReliability
}) => [
  ...input.controllers
    .filter((controller) => controller.status === 'degraded')
    .map((controller) => `controller:${controller.name}`),
  ...input.runtimeAdapters
    .filter((adapter) => adapter.status === 'degraded')
    .map((adapter) => `runtime_adapter:${adapter.name}`),
  ...(input.grpc.status === 'degraded' ? ['grpc'] : []),
  ...(input.agentRunIngestion.status === 'degraded' ? ['agentrun_ingestion'] : []),
  ...(input.watchReliability.status === 'degraded' ? ['watch_reliability'] : []),
]

export const buildAgentsControlPlaneStatus = (
  input: BuildAgentsControlPlaneStatusInput,
  deps: AgentsControlPlaneStatusDependencies = {},
): AgentsControlPlaneStatus => {
  const now = input.now ?? deps.now?.() ?? new Date()
  const env = input.env ?? deps.env ?? process.env
  const namespace = input.namespace
  const runtimeEvidence = input.runtimeEvidence
  const watchReliability = input.watchReliability ?? unknownWatchReliability()
  const rolloutHealth = runtimeEvidence?.rolloutHealth ?? unknownRolloutHealth()
  const agentsHealth = (deps.getAgentsControllerHealth ?? getAgentsControllerHealth)()
  const controllers = [
    buildControllerStatus('agents-controller', agentsHealth, namespace, now),
    buildControllerStatus(
      'orchestration-controller',
      (deps.getOrchestrationControllerHealth ?? getOrchestrationControllerHealth)(),
      namespace,
      now,
    ),
    buildControllerStatus(
      'supporting-controller',
      (deps.getSupportingControllerHealth ?? getSupportingControllerHealth)(),
      namespace,
      now,
    ),
  ]
  const workflowController = controllers.find((controller) => controller.name === 'agents-controller') ?? controllers[0]
  const runtimeAdapters = [
    buildRuntimeAdapterStatus('workflow', workflowController, namespace, now),
    buildRuntimeAdapterStatus('job', workflowController, namespace, now),
    {
      name: 'custom',
      available: true,
      status: 'unknown' as const,
      message: 'custom runtime configured per AgentRun',
      endpoint: '',
      authority: buildAuthority(namespace, now, 'custom runtime is resolved per AgentRun'),
    },
  ]
  const agentRunIngestion = buildAgentRunIngestionStatus(namespace, agentsHealth, deps)
  const leaderElection = (deps.getLeaderElectionStatus ?? getLeaderElectionStatus)()
  const controllerWitness = buildControllerWitnessQuorum({
    namespace,
    now,
    servingController: workflowController,
    effectiveController: workflowController,
    rolloutHealth,
    agentRunIngestion,
    watchReliability,
    controllerDeploymentName: 'agents-controllers',
    leaderIdentity: leaderElection.identity,
  })
  const degradedComponents = buildDegradedComponents({
    controllers,
    runtimeAdapters,
    grpc: input.grpc,
    agentRunIngestion,
    watchReliability,
  })
  const executionTrust = input.executionTrust ?? assumedHealthyExecutionTrust(now)
  const database = buildDatabaseStatus(env)
  const runtimeAdmission = buildRuntimeAdmissionSnapshot({
    now,
    executionTrust,
  })
  const controllerIngestionSettlement = buildControlPlaneControllerIngestionSettlement({
    now,
    namespace,
    servingReadiness: degradedComponents.length > 0 ? 'degraded' : 'ok',
    controllerWitness,
    agentRunIngestion,
    executionTrust,
    database,
    rolloutHealth,
  })
  const authorityProvenanceSettlement = buildAuthorityProvenanceSettlement({
    now,
    namespace,
    database,
    controllerWitness,
    agentRunIngestion,
    watchReliability,
    workflows: runtimeEvidence?.workflows ?? unknownWorkflows(),
    rolloutHealth,
    runtimeKits: runtimeAdmission.runtimeKits,
    admissionPassports: runtimeAdmission.admissionPassports,
    projectionWatermarks: runtimeAdmission.projectionWatermarks,
  })

  return {
    service: input.service ?? resolveRuntimeServiceName(),
    generated_at: now.toISOString(),
    leader_election: buildLeaderElectionStatus(leaderElection),
    controllers,
    runtime_adapters: runtimeAdapters,
    database,
    grpc: input.grpc,
    watch_reliability: watchReliability,
    agentrun_ingestion: agentRunIngestion,
    control_plane_controller_witness: controllerWitness,
    controller_ingestion_settlement: controllerIngestionSettlement,
    authority_provenance_settlement: authorityProvenanceSettlement,
    runtime_kits: runtimeAdmission.runtimeKits,
    admission_passports: runtimeAdmission.admissionPassports,
    serving_passport_id: runtimeAdmission.servingPassportId,
    recovery_warrants: runtimeAdmission.recoveryWarrants,
    runtime_proof_cells: runtimeAdmission.runtimeProofCells,
    projection_watermarks: runtimeAdmission.projectionWatermarks,
    workflows: runtimeEvidence?.workflows ?? unknownWorkflows(),
    rollout_health: rolloutHealth,
    namespaces: [
      {
        namespace,
        status: degradedComponents.length > 0 ? 'degraded' : 'healthy',
        degraded_components: degradedComponents,
      },
    ],
  }
}

const toStatusError = (operation: string) => (error: unknown) =>
  new AgentsControlPlaneStatusError({
    operation,
    message: error instanceof Error ? error.message : String(error),
  })

export const createAgentsControlPlaneStatusService = (
  deps: AgentsControlPlaneStatusDependencies = {},
): AgentsControlPlaneStatusService => ({
  get: (input) =>
    Effect.gen(function* () {
      const grpc =
        input.grpc ??
        (yield* Effect.tryPromise({
          try: () => (deps.resolveGrpcStatus ?? resolveGrpcStatus)(),
          catch: toStatusError('resolveGrpcStatus'),
        }))
      const env = input.env ?? deps.env ?? process.env
      const now = input.now ?? deps.now?.() ?? new Date()
      const collectRuntimeEvidence =
        deps.collectRuntimeEvidence ??
        ((collectInput: { namespace: string; now: Date; env: EnvSource }) =>
          createControlPlaneRuntimeEvidenceService({ env })
            .collect(collectInput)
            .pipe(
              Effect.mapError(
                (error) =>
                  new AgentsControlPlaneStatusError({
                    operation: error.operation,
                    message: error.message,
                  }),
              ),
            ))
      const runtimeEvidence = yield* collectRuntimeEvidence({ namespace: input.namespace, now, env })
      const collectWatchReliability =
        deps.collectWatchReliability ??
        ((collectInput: { namespace: string; now: Date; env: EnvSource }) =>
          createControlPlaneWatchReliabilityService({
            env: collectInput.env,
            now: () => collectInput.now,
          })
            .summarize()
            .pipe(
              Effect.mapError(
                (error) =>
                  new AgentsControlPlaneStatusError({
                    operation: error.operation,
                    message: error.message,
                  }),
              ),
            ))
      const watchReliability = yield* collectWatchReliability({ namespace: input.namespace, now, env })

      return yield* Effect.try({
        try: () => buildAgentsControlPlaneStatus({ ...input, grpc, now, env, runtimeEvidence, watchReliability }, deps),
        catch: toStatusError('buildControlPlaneStatus'),
      })
    }),
})

export const AgentsControlPlaneStatusApiLive = Layer.succeed(
  AgentsControlPlaneStatusApi,
  createAgentsControlPlaneStatusService(),
)

export const makeAgentsControlPlaneStatusLayer = (deps: AgentsControlPlaneStatusDependencies = {}) =>
  Layer.succeed(AgentsControlPlaneStatusApi, createAgentsControlPlaneStatusService(deps))

export const getAgentsControlPlaneStatusEffect = (input: GetAgentsControlPlaneStatusInput) =>
  Effect.flatMap(AgentsControlPlaneStatusApi, (service) => service.get(input))

export const getAgentsControlPlaneStatus = (
  input: GetAgentsControlPlaneStatusInput,
  deps: AgentsControlPlaneStatusDependencies = {},
) => Effect.runPromise(createAgentsControlPlaneStatusService(deps).get(input))
