import { Context, Data, Effect, Layer } from 'effect'

import { assessAgentRunIngestion, getAgentsControllerHealth, type AgentsControllerHealth } from './agents-controller'
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
  ControlPlaneControllerWitnessQuorum,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  ControllerStatus,
  HeartbeatAuthoritySource,
  RuntimeAdapterStatus,
} from './control-plane-status-contract'
import { AGENTS_CONTROLLER_WITNESS_DESIGN_ARTIFACT } from './control-plane-status-contract'
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

export type BuildAgentsControlPlaneStatusInput = {
  namespace: string
  grpc: GrpcStatus
  service?: string
  now?: Date
  env?: EnvSource
  runtimeEvidence?: ControlPlaneRuntimeEvidence
  watchReliability?: ControlPlaneWatchReliability
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

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

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

const witnessId = (namespace: string, surface: string) => `witness:${surface}:${namespace}:agents-control-plane-status`

const hasWatchEpoch = (
  watchReliability: ControlPlaneWatchReliability,
  agentRunIngestion: AgentsControlPlaneStatus['agentrun_ingestion'],
) =>
  watchReliability.status === 'healthy' ||
  (agentRunIngestion.status === 'healthy' && agentRunIngestion.last_watch_event_at !== null)

const buildControlPlaneControllerWitness = (input: {
  namespace: string
  now: Date
  controller: ControllerStatus
  agentRunIngestion: AgentsControlPlaneStatus['agentrun_ingestion']
  watchReliability: ControlPlaneWatchReliability
  leaderElection: LeaderElectionStatus
}): ControlPlaneControllerWitnessQuorum => {
  const generatedAt = input.now.toISOString()
  const expiresAt = addSeconds(input.now, 60).toISOString()
  const deploymentAvailable = input.controller.enabled && input.controller.started
  const watchEpochCurrent = hasWatchEpoch(input.watchReliability, input.agentRunIngestion)
  const controllerSelfReportCurrent = deploymentAvailable && input.agentRunIngestion.status === 'healthy'
  const decision =
    input.agentRunIngestion.status === 'degraded'
      ? 'hold_material'
      : controllerSelfReportCurrent
        ? 'allow'
        : deploymentAvailable && watchEpochCurrent
          ? 'repair_only'
          : 'hold_material'
  const reasonCodes = [
    ...(deploymentAvailable ? [] : ['controller_deployment_unavailable']),
    ...(watchEpochCurrent ? [] : ['watch_epoch_not_current']),
    ...(controllerSelfReportCurrent ? [] : ['controller_self_report_not_current']),
    ...(input.agentRunIngestion.status === 'healthy' ? [] : [`agentrun_ingestion_${input.agentRunIngestion.status}`]),
  ]
  const witnessRefs = [
    witnessId(input.namespace, 'kubernetes_deployment'),
    witnessId(input.namespace, 'watch_epoch'),
    witnessId(input.namespace, 'agentrun_ingestion'),
  ]

  return {
    mode: 'shadow',
    design_artifact: AGENTS_CONTROLLER_WITNESS_DESIGN_ARTIFACT,
    quorum_id: `controller-witness:${input.namespace}:agents-control-plane-status`,
    generated_at: generatedAt,
    expires_at: expiresAt,
    namespace: input.namespace,
    decision,
    reason_codes: reasonCodes,
    message: controllerSelfReportCurrent
      ? 'Agents controller ingestion self-report is current'
      : 'Agents controller ingestion self-report is not fully current',
    witness_refs: witnessRefs,
    deployment_available: deploymentAvailable,
    watch_epoch_current: watchEpochCurrent,
    controller_self_report_current: controllerSelfReportCurrent,
    witnesses: [
      {
        witness_id: witnessRefs[0],
        generated_at: generatedAt,
        expires_at: expiresAt,
        namespace: input.namespace,
        controller_surface: 'kubernetes_deployment',
        deployment_ref: `${input.namespace}/agents-controllers`,
        pod_uid: null,
        image_ref: null,
        leader_identity: input.leaderElection.identity,
        controller_started: input.controller.started,
        deployment_available: deploymentAvailable,
        watch_epoch_id: null,
        ingestion_epoch_id: null,
        last_watch_event_at: null,
        last_resync_at: null,
        observed_run_count: null,
        untouched_run_count: null,
        decision: deploymentAvailable ? 'allow' : 'repair_only',
        reason_codes: deploymentAvailable ? [] : ['controller_deployment_unavailable'],
      },
      {
        witness_id: witnessRefs[1],
        generated_at: generatedAt,
        expires_at: expiresAt,
        namespace: input.namespace,
        controller_surface: 'watch_epoch',
        deployment_ref: null,
        pod_uid: null,
        image_ref: null,
        leader_identity: input.leaderElection.identity,
        controller_started: null,
        deployment_available: null,
        watch_epoch_id: `watch:${input.namespace}:agents-control-plane-status`,
        ingestion_epoch_id: null,
        last_watch_event_at:
          input.watchReliability.streams[0]?.last_seen_at ?? input.agentRunIngestion.last_watch_event_at,
        last_resync_at: null,
        observed_run_count: input.watchReliability.total_events,
        untouched_run_count: null,
        decision: watchEpochCurrent ? 'allow' : 'hold_material',
        reason_codes: watchEpochCurrent ? [] : ['watch_epoch_not_current'],
      },
      {
        witness_id: witnessRefs[2],
        generated_at: generatedAt,
        expires_at: expiresAt,
        namespace: input.namespace,
        controller_surface: 'agentrun_ingestion',
        deployment_ref: null,
        pod_uid: null,
        image_ref: null,
        leader_identity: input.leaderElection.identity,
        controller_started: null,
        deployment_available: null,
        watch_epoch_id: null,
        ingestion_epoch_id: `ingestion:${input.namespace}:agents-control-plane-status`,
        last_watch_event_at: input.agentRunIngestion.last_watch_event_at,
        last_resync_at: input.agentRunIngestion.last_resync_at,
        observed_run_count: null,
        untouched_run_count: input.agentRunIngestion.untouched_run_count,
        decision: input.agentRunIngestion.status === 'healthy' ? 'allow' : 'hold_material',
        reason_codes:
          input.agentRunIngestion.status === 'healthy' ? [] : [`agentrun_ingestion_${input.agentRunIngestion.status}`],
      },
    ],
    rollback_target: 'use Agents controller logs and AgentRun status conditions for controller ingestion proof',
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
  const controllerWitness = buildControlPlaneControllerWitness({
    namespace,
    now,
    controller: workflowController,
    agentRunIngestion,
    watchReliability,
    leaderElection,
  })
  const degradedComponents = buildDegradedComponents({
    controllers,
    runtimeAdapters,
    grpc: input.grpc,
    agentRunIngestion,
    watchReliability,
  })

  return {
    service: input.service ?? resolveRuntimeServiceName(),
    generated_at: now.toISOString(),
    leader_election: buildLeaderElectionStatus(leaderElection),
    controllers,
    runtime_adapters: runtimeAdapters,
    database: buildDatabaseStatus(env),
    grpc: input.grpc,
    watch_reliability: watchReliability,
    agentrun_ingestion: agentRunIngestion,
    control_plane_controller_witness: controllerWitness,
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

export const getAgentsControlPlaneStatusEffect = (input: GetAgentsControlPlaneStatusInput) =>
  Effect.flatMap(AgentsControlPlaneStatusApi, (service) => service.get(input))

export const getAgentsControlPlaneStatus = (
  input: GetAgentsControlPlaneStatusInput,
  deps: AgentsControlPlaneStatusDependencies = {},
) => Effect.runPromise(createAgentsControlPlaneStatusService(deps).get(input))
