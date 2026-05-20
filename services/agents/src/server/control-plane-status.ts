import { Context, Data, Effect, Layer } from 'effect'

import { assessAgentRunIngestion, getAgentsControllerHealth, type AgentsControllerHealth } from './agents-controller'
import type { GrpcStatus } from './control-plane-grpc'
import { resolveGrpcStatus } from './control-plane-grpc'
import {
  createControlPlaneRuntimeEvidenceService,
  type ControlPlaneRuntimeEvidence,
  type ControlPlaneRolloutHealth,
  type WorkflowsReliabilityStatus,
} from './control-plane-runtime-evidence'
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
  lastCheckedAt: string | null
}

type EnvSource = Record<string, string | undefined>
type ComponentStatus = 'healthy' | 'degraded' | 'disabled' | 'unknown'

export type HeartbeatAuthoritySource = {
  mode: 'heartbeat' | 'local' | 'rollout' | 'unknown'
  namespace: string
  source_deployment: string
  source_pod: string
  observed_at: string | null
  fresh: boolean
  message: string
}

export type ControllerStatus = {
  name: string
  enabled: boolean
  started: boolean
  scope_namespaces: string[]
  crds_ready: boolean
  missing_crds: string[]
  last_checked_at: string
  status: ComponentStatus
  message: string
  authority: HeartbeatAuthoritySource
}

export type RuntimeAdapterStatus = {
  name: string
  available: boolean
  status: ComponentStatus | 'configured'
  message: string
  endpoint: string
  authority: HeartbeatAuthoritySource
}

export type AgentsControlPlaneStatus = {
  service: string
  generated_at: string
  leader_election: {
    enabled: boolean
    required: boolean
    is_leader: boolean
    lease_name: string
    lease_namespace: string
    identity: string
    last_transition_at: string
    last_attempt_at: string
    last_success_at: string
    last_error: string
  }
  controllers: ControllerStatus[]
  runtime_adapters: RuntimeAdapterStatus[]
  database: {
    configured: boolean
    connected: boolean
    status: 'disabled' | 'healthy' | 'degraded' | 'unknown'
    message: string
    latency_ms: number
    migration_consistency: {
      status: 'unknown'
      migration_table: string | null
      registered_count: number
      applied_count: number
      unapplied_count: number
      unexpected_count: number
      latest_registered: string | null
      latest_applied: string | null
      missing_migrations: string[]
      unexpected_migrations: string[]
      message: string
    }
  }
  grpc: GrpcStatus
  watch_reliability: {
    status: 'unknown'
    window_minutes: number
    observed_streams: number
    total_events: number
    total_errors: number
    total_restarts: number
    streams: unknown[]
  }
  agentrun_ingestion: {
    namespace: string
    status: 'healthy' | 'degraded' | 'unknown'
    message: string
    last_watch_event_at: string | null
    last_resync_at: string | null
    untouched_run_count: number
    oldest_untouched_age_seconds: number | null
  }
  runtime_kits: unknown[]
  admission_passports: unknown[]
  serving_passport_id: string | null
  recovery_warrants: unknown[]
  runtime_proof_cells: unknown[]
  projection_watermarks: unknown[]
  workflows: {
    active_job_runs: number
    recent_failed_jobs: number
    backoff_limit_exceeded_jobs: number
    window_minutes: number
    top_failure_reasons: WorkflowsReliabilityStatus['top_failure_reasons']
    data_confidence: WorkflowsReliabilityStatus['data_confidence']
    collection_errors: number
    collected_namespaces: number
    target_namespaces: number
    message: string
  }
  rollout_health: ControlPlaneRolloutHealth
  namespaces: Array<{
    namespace: string
    status: 'healthy' | 'degraded'
    degraded_components: string[]
  }>
}

export class AgentsControlPlaneStatusError extends Data.TaggedError('AgentsControlPlaneStatusError')<{
  readonly operation: string
  readonly message: string
}> {}

export type BuildAgentsControlPlaneStatusInput = {
  namespace: string
  grpc: GrpcStatus
  service?: string
  now?: Date
  env?: EnvSource
  runtimeEvidence?: ControlPlaneRuntimeEvidence
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

const buildDegradedComponents = (input: {
  controllers: ControllerStatus[]
  runtimeAdapters: RuntimeAdapterStatus[]
  grpc: GrpcStatus
  agentRunIngestion: AgentsControlPlaneStatus['agentrun_ingestion']
}) => [
  ...input.controllers
    .filter((controller) => controller.status === 'degraded')
    .map((controller) => `controller:${controller.name}`),
  ...input.runtimeAdapters
    .filter((adapter) => adapter.status === 'degraded')
    .map((adapter) => `runtime_adapter:${adapter.name}`),
  ...(input.grpc.status === 'degraded' ? ['grpc'] : []),
  ...(input.agentRunIngestion.status === 'degraded' ? ['agentrun_ingestion'] : []),
]

export const buildAgentsControlPlaneStatus = (
  input: BuildAgentsControlPlaneStatusInput,
  deps: AgentsControlPlaneStatusDependencies = {},
): AgentsControlPlaneStatus => {
  const now = input.now ?? deps.now?.() ?? new Date()
  const env = input.env ?? deps.env ?? process.env
  const namespace = input.namespace
  const runtimeEvidence = input.runtimeEvidence
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
  const degradedComponents = buildDegradedComponents({
    controllers,
    runtimeAdapters,
    grpc: input.grpc,
    agentRunIngestion,
  })

  return {
    service: input.service ?? resolveRuntimeServiceName(),
    generated_at: now.toISOString(),
    leader_election: buildLeaderElectionStatus((deps.getLeaderElectionStatus ?? getLeaderElectionStatus)()),
    controllers,
    runtime_adapters: runtimeAdapters,
    database: buildDatabaseStatus(env),
    grpc: input.grpc,
    watch_reliability: {
      status: 'unknown',
      window_minutes: 0,
      observed_streams: 0,
      total_events: 0,
      total_errors: 0,
      total_restarts: 0,
      streams: [],
    },
    agentrun_ingestion: agentRunIngestion,
    runtime_kits: [],
    admission_passports: [],
    serving_passport_id: null,
    recovery_warrants: [],
    runtime_proof_cells: [],
    projection_watermarks: [],
    workflows: runtimeEvidence?.workflows ?? unknownWorkflows(),
    rollout_health: runtimeEvidence?.rolloutHealth ?? unknownRolloutHealth(),
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

      return yield* Effect.try({
        try: () => buildAgentsControlPlaneStatus({ ...input, grpc, now, env, runtimeEvidence }, deps),
        catch: toStatusError('buildControlPlaneStatus'),
      })
    }),
})

export const AgentsControlPlaneStatusApiLive = Layer.succeed(
  AgentsControlPlaneStatusApi,
  createAgentsControlPlaneStatusService(),
)

export const getAgentsControlPlaneStatusEffect = (input: GetAgentsControlPlaneStatusInput) =>
  Effect.flatMap(AgentsControlPlaneStatusApi, (service) => service.get(input))

export const getAgentsControlPlaneStatus = (
  input: GetAgentsControlPlaneStatusInput,
  deps: AgentsControlPlaneStatusDependencies = {},
) => Effect.runPromise(createAgentsControlPlaneStatusService(deps).get(input))
