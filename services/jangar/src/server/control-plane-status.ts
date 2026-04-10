import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk'

import { assessAgentRunIngestion, getAgentsControllerHealth } from '~/server/agents-controller'
import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import {
  createControlPlaneHeartbeatStore,
  isHeartbeatFresh,
  type ControlPlaneHeartbeatRow,
  type ControlPlaneHeartbeatStoreGetInput,
} from '~/server/control-plane-heartbeat-store'
import { buildRuntimeAdmissionSnapshot, type RuntimeAdmissionSnapshot } from '~/server/control-plane-runtime-admission'
import { checkDatabase } from '~/server/control-plane-db-status'
import {
  buildExecutionTrust,
  resolveExecutionTrustSummaryLimit,
  type ExecutionTrustInput,
  type ExecutionTrustSnapshot,
} from '~/server/control-plane-execution-trust'
import { resolveEmpiricalServices } from '~/server/control-plane-empirical-services'
import {
  buildRolloutHealth,
  maybeUseSplitTopologyControllerRollout,
  maybeUseSplitTopologyRuntimeRollout,
  unknownRolloutHealth,
} from '~/server/control-plane-rollout-health'
import type {
  AgentRunIngestionStatus,
  ControlPlaneStatus,
  ControllerStatus,
  DatabaseStatus,
  GrpcStatus,
  RuntimeAdapterStatus,
} from '~/server/control-plane-status-types'
import {
  buildDependencyQuorum,
  resolveWatchReliabilityBlockErrorsThreshold,
  resolveWatchReliabilityBlockRestartsThreshold,
  resolveWorkflowNamespaces,
  resolveWorkflowSwarms,
  resolveWorkflowWindowMinutes,
  resolveWorkflowsReliabilityStatus,
  type WorkflowsReliabilityStatusInput,
} from '~/server/control-plane-workflows'
import {
  getWatchReliabilitySummary,
  type ControlPlaneWatchReliabilitySummary,
} from '~/server/control-plane-watch-reliability'
import { createKubeGateway, type KubeGateway } from '~/server/kube-gateway'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'
import type { ExecutionTrustStatus, WorkflowsReliabilityStatus } from '~/data/agents-control-plane'

export type { ControlPlaneStatus, DatabaseStatus, GrpcStatus } from './control-plane-status-types'
export { buildExecutionTrust } from './control-plane-execution-trust'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`

type ControllerHealth = ReturnType<typeof getAgentsControllerHealth>

export type ControlPlaneStatusOptions = {
  namespace: string
  service?: string
  grpc: GrpcStatus
}

export type ControlPlaneStatusDeps = {
  now?: () => Date
  getAgentsControllerHealth?: () => ControllerHealth
  getSupportingControllerHealth?: () => ControllerHealth
  getOrchestrationControllerHealth?: () => ControllerHealth
  getHeartbeat?: (input: ControlPlaneHeartbeatStoreGetInput) => Promise<ControlPlaneHeartbeatRow | null>
  resolveTemporalAdapter?: () => Promise<RuntimeAdapterStatus>
  checkDatabase?: () => Promise<DatabaseStatus>
  getWatchReliabilitySummary?: () => ControlPlaneWatchReliabilitySummary
  getWorkflowsReliabilityStatus?: (input: WorkflowsReliabilityStatusInput) => Promise<WorkflowsReliabilityStatus>
  resolveEmpiricalServices?: typeof resolveEmpiricalServices
  resolveExecutionTrust?: (input: ExecutionTrustInput) => Promise<ExecutionTrustSnapshot>
  resolveRuntimeAdmission?: (input: { now: Date; executionTrust: ExecutionTrustStatus }) => RuntimeAdmissionSnapshot
  kubeGateway?: KubeGateway
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

type HeartbeatResolver = (input: ControlPlaneHeartbeatStoreGetInput) => Promise<ControlPlaneHeartbeatRow | null>

let sharedHeartbeatStore: ReturnType<typeof createControlPlaneHeartbeatStore> | null = null
let heartbeatStoreUnavailable = false

const resolveHeartbeatStore = () => {
  if (sharedHeartbeatStore) return sharedHeartbeatStore
  if (heartbeatStoreUnavailable) return null

  try {
    sharedHeartbeatStore = createControlPlaneHeartbeatStore()
    return sharedHeartbeatStore
  } catch (error) {
    heartbeatStoreUnavailable = true
    console.warn('[jangar] control-plane heartbeat store unavailable:', normalizeMessage(error))
    return null
  }
}

const buildAuthorityFromHeartbeat = (input: {
  component: string
  namespace: string
  row: ControlPlaneHeartbeatRow | null
  now: Date
  fallbackMode: 'heartbeat' | 'local' | 'rollout' | 'unknown'
  fallbackMessage: string
}) => {
  if (!input.row) {
    return {
      mode: input.fallbackMode,
      namespace: input.namespace,
      source_deployment: '',
      source_pod: '',
      observed_at: null,
      fresh: false,
      message: input.fallbackMessage,
    }
  }

  const observedAt = input.row.observed_at ? new Date(input.row.observed_at).toISOString() : null
  const fresh = isHeartbeatFresh(input.row, input.now)
  const baseMessage = input.row.message?.trim() || ''

  return {
    mode: 'heartbeat' as const,
    namespace: input.row.namespace,
    source_deployment: input.row.deployment_name,
    source_pod: input.row.pod_name,
    observed_at: observedAt,
    fresh,
    message: baseMessage.length > 0 ? baseMessage : `${input.component} heartbeat ${fresh ? 'is healthy' : 'stale'}`,
  }
}

const defaultGetHeartbeat: HeartbeatResolver = async (input) => {
  const store = resolveHeartbeatStore()
  if (!store) return null
  try {
    return await store.getHeartbeat(input)
  } catch (error) {
    console.warn('[jangar] failed to read control-plane heartbeat:', normalizeMessage(error))
    return null
  }
}

const localAuthority = (namespace: string) => ({
  mode: 'local' as const,
  namespace,
  source_deployment: '',
  source_pod: '',
  observed_at: new Date().toISOString(),
  fresh: true,
  message: 'using local controller state',
})

const buildAgentRunIngestionStatus = (namespace: string, health: ControllerHealth): AgentRunIngestionStatus => {
  const assessment = assessAgentRunIngestion(namespace, health)

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

const buildControllerStatusFromHeartbeat = ({
  name,
  health,
  heartbeat,
  now,
}: {
  name: string
  health: ControllerHealth
  heartbeat: ControlPlaneHeartbeatRow | null
  now: Date
}): ControllerStatus => {
  const authority = buildAuthorityFromHeartbeat({
    component: name,
    namespace: (Array.isArray(health.namespaces) ? health.namespaces : [])[0] ?? 'agents',
    row: heartbeat,
    now,
    fallbackMode: 'unknown',
    fallbackMessage: `No authoritative heartbeat for ${name}`,
  })

  if (!heartbeat || !authority.fresh) {
    return {
      name,
      enabled: health.enabled,
      started: false,
      scope_namespaces: Array.isArray(health.namespaces) ? health.namespaces : [],
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'unknown',
      message: authority.mode === 'heartbeat' ? 'heartbeat stale or missing' : authority.message,
      authority: {
        ...authority,
        message: authority.mode === 'heartbeat' ? 'heartbeat stale or missing' : authority.message,
      },
    }
  }

  const status =
    heartbeat.status === 'healthy' || heartbeat.status === 'degraded' || heartbeat.status === 'disabled'
      ? heartbeat.status
      : 'unknown'
  const rowMessage = heartbeat.message?.trim() || ''

  return {
    name,
    enabled: heartbeat.enabled,
    started: heartbeat.status !== 'disabled',
    scope_namespaces: Array.isArray(health.namespaces) ? health.namespaces : [],
    crds_ready: status === 'healthy',
    missing_crds: health.missingCrds,
    last_checked_at: heartbeat.observed_at
      ? new Date(heartbeat.observed_at).toISOString()
      : (health.lastCheckedAt ?? ''),
    status,
    message: rowMessage.length > 0 ? rowMessage : status === 'healthy' ? '' : authority.message,
    authority,
  }
}

const buildRuntimeAdapterStatusFromSource = ({
  name,
  source,
  healthyMessage,
  defaultMessage,
}: {
  name: string
  source: ControllerStatus
  healthyMessage: string
  defaultMessage: string
}): RuntimeAdapterStatus => {
  if (source.status === 'healthy') {
    return {
      name,
      available: true,
      status: 'configured',
      message: healthyMessage,
      endpoint: '',
      authority: source.authority,
    }
  }
  if (source.status === 'unknown') {
    return {
      name,
      available: false,
      status: 'unknown',
      message: source.message || defaultMessage,
      endpoint: '',
      authority: source.authority,
    }
  }
  if (source.status === 'disabled') {
    return {
      name,
      available: false,
      status: 'disabled',
      message: source.message || defaultMessage,
      endpoint: '',
      authority: source.authority,
    }
  }
  return {
    name,
    available: false,
    status: 'degraded',
    message: source.message || defaultMessage,
    endpoint: '',
    authority: source.authority,
  }
}

const resolveTemporalAdapter = async (): Promise<RuntimeAdapterStatus> => {
  try {
    const config = await loadTemporalConfig({
      defaults: {
        host: DEFAULT_TEMPORAL_HOST,
        port: DEFAULT_TEMPORAL_PORT,
        address: DEFAULT_TEMPORAL_ADDRESS,
      },
    })
    return {
      name: 'temporal',
      available: true,
      status: 'configured',
      message: 'temporal configuration resolved',
      endpoint: config.address ?? DEFAULT_TEMPORAL_ADDRESS,
      authority: localAuthority('agents'),
    }
  } catch (error) {
    return {
      name: 'temporal',
      available: false,
      status: 'degraded',
      message: normalizeMessage(error),
      endpoint: DEFAULT_TEMPORAL_ADDRESS,
      authority: localAuthority('agents'),
    }
  }
}

export const buildControlPlaneStatus = async (
  options: ControlPlaneStatusOptions,
  deps: ControlPlaneStatusDeps = {},
): Promise<ControlPlaneStatus> => {
  const now = (deps.now ?? (() => new Date()))()
  const kubeGateway = deps.kubeGateway ?? createKubeGateway()
  const heartbeatResolver = deps.getHeartbeat ?? defaultGetHeartbeat
  const agentsHealth = (deps.getAgentsControllerHealth ?? getAgentsControllerHealth)()
  const supportingHealth = (deps.getSupportingControllerHealth ?? getSupportingControllerHealth)()
  const orchestrationHealth = (deps.getOrchestrationControllerHealth ?? getOrchestrationControllerHealth)()

  const [agentsHeartbeat, supportingHeartbeat, orchestrationHeartbeat, workflowRuntimeHeartbeat] = await Promise.all([
    heartbeatResolver({ namespace: options.namespace, component: 'agents-controller', workloadRole: 'controllers' }),
    heartbeatResolver({
      namespace: options.namespace,
      component: 'supporting-controller',
      workloadRole: 'controllers',
    }),
    heartbeatResolver({
      namespace: options.namespace,
      component: 'orchestration-controller',
      workloadRole: 'controllers',
    }),
    heartbeatResolver({ namespace: options.namespace, component: 'workflow-runtime', workloadRole: 'controllers' }),
  ])

  const agentsController = buildControllerStatusFromHeartbeat({
    name: 'agents-controller',
    health: agentsHealth,
    heartbeat: agentsHeartbeat,
    now,
  })
  const supportingController = buildControllerStatusFromHeartbeat({
    name: 'supporting-controller',
    health: supportingHealth,
    heartbeat: supportingHeartbeat,
    now,
  })
  const orchestrationController = buildControllerStatusFromHeartbeat({
    name: 'orchestration-controller',
    health: orchestrationHealth,
    heartbeat: orchestrationHeartbeat,
    now,
  })
  const workflowRuntimeController = buildControllerStatusFromHeartbeat({
    name: 'workflow-runtime',
    health: agentsHealth,
    heartbeat: workflowRuntimeHeartbeat,
    now,
  })
  const workflowAdapter = buildRuntimeAdapterStatusFromSource({
    name: 'workflow',
    source: workflowRuntimeController,
    healthyMessage: 'native workflow runtime via Kubernetes Jobs',
    defaultMessage: 'workflow runtime unavailable',
  })
  const jobAdapter = buildRuntimeAdapterStatusFromSource({
    name: 'job',
    source: workflowRuntimeController,
    healthyMessage: 'job runtime via Kubernetes Jobs',
    defaultMessage: 'job runtime unavailable',
  })

  const runtimeAdapters: RuntimeAdapterStatus[] = [
    workflowAdapter,
    jobAdapter,
    await (deps.resolveTemporalAdapter ?? resolveTemporalAdapter)(),
    {
      name: 'custom',
      available: true,
      status: 'unknown',
      message: 'custom runtime configured per AgentRun',
      endpoint: '',
      authority: localAuthority('agents'),
    },
  ]

  const database = await (deps.checkDatabase ?? checkDatabase)()
  const grpcStatus = options.grpc
  const watchReliability = (deps.getWatchReliabilitySummary ?? getWatchReliabilitySummary)()
  let rolloutHealth
  try {
    rolloutHealth = await buildRolloutHealth({ namespace: options.namespace, kube: kubeGateway })
  } catch {
    rolloutHealth = unknownRolloutHealth()
  }

  const effectiveControllers = [
    maybeUseSplitTopologyControllerRollout({
      namespace: options.namespace,
      now,
      controller: agentsController,
      healthEnabled: agentsHealth.enabled,
      rolloutHealth,
    }),
    maybeUseSplitTopologyControllerRollout({
      namespace: options.namespace,
      now,
      controller: supportingController,
      healthEnabled: supportingHealth.enabled,
      rolloutHealth,
    }),
    maybeUseSplitTopologyControllerRollout({
      namespace: options.namespace,
      now,
      controller: orchestrationController,
      healthEnabled: orchestrationHealth.enabled,
      rolloutHealth,
    }),
  ]
  const effectiveRuntimeAdapters = runtimeAdapters.map((adapter) =>
    maybeUseSplitTopologyRuntimeRollout({
      namespace: options.namespace,
      now,
      adapter,
      healthEnabled: agentsHealth.enabled,
      rolloutHealth,
    }),
  )

  const statusConfig = resolveControlPlaneStatusConfig(process.env)
  const warningBackoffThreshold = statusConfig.workflowsWarningBackoffThreshold
  const degradedBackoffThreshold = statusConfig.workflowsDegradedBackoffThreshold
  const watchReliabilityBlockErrorsThreshold = resolveWatchReliabilityBlockErrorsThreshold()
  const watchReliabilityBlockRestartsThreshold = resolveWatchReliabilityBlockRestartsThreshold()
  const executionTrust = await (deps.resolveExecutionTrust ?? buildExecutionTrust)({
    namespace: options.namespace,
    now,
    swarms: resolveWorkflowSwarms(),
    kube: kubeGateway,
    summaryLimit: resolveExecutionTrustSummaryLimit(),
  }).catch(
    (error: unknown): ExecutionTrustSnapshot => ({
      executionTrust: {
        status: 'unknown',
        reason: `execution trust evaluation failed: ${normalizeMessage(error)}`,
        last_evaluated_at: now.toISOString(),
        blocking_windows: [],
        evidence_summary: [],
      },
      swarms: [],
      stages: [],
    }),
  )

  const workflows = await (deps.getWorkflowsReliabilityStatus ?? resolveWorkflowsReliabilityStatus)({
    now,
    namespace: options.namespace,
    namespaces: resolveWorkflowNamespaces(options.namespace),
    windowMinutes: resolveWorkflowWindowMinutes(),
    swarms: resolveWorkflowSwarms(),
    kube: kubeGateway,
  })
  const empiricalServices = await (deps.resolveEmpiricalServices ?? resolveEmpiricalServices)()
  const runtimeAdmission = (deps.resolveRuntimeAdmission ?? buildRuntimeAdmissionSnapshot)({
    now,
    executionTrust: executionTrust.executionTrust,
  })

  const isWorkflowsDataUnknown = workflows.data_confidence === 'unknown'
  const isWorkflowsDataDegraded = workflows.data_confidence === 'degraded'
  const isWorkflowsDataUnavailable = isWorkflowsDataUnknown || isWorkflowsDataDegraded
  const isWorkflowsWarning = workflows.backoff_limit_exceeded_jobs >= warningBackoffThreshold
  const isWorkflowsDegraded = workflows.backoff_limit_exceeded_jobs >= degradedBackoffThreshold
  const agentRunIngestion = buildAgentRunIngestionStatus(options.namespace, agentsHealth)
  const dependencyQuorum = buildDependencyQuorum({
    controllers: effectiveControllers,
    runtimeAdapters: effectiveRuntimeAdapters,
    database,
    empiricalServices,
    watchReliability,
    workflows,
    rolloutHealth,
    now,
    warningBackoffThreshold,
    degradedBackoffThreshold,
    watchReliabilityBlockErrorsThreshold,
    watchReliabilityBlockRestartsThreshold,
    executionTrust: executionTrust.executionTrust,
  })

  const leaderElection = getLeaderElectionStatus()

  const degradedComponents = [
    ...effectiveControllers
      .filter(
        (controller) =>
          controller.status === 'degraded' || controller.status === 'disabled' || controller.status === 'unknown',
      )
      .map((controller) => controller.name),
    ...effectiveRuntimeAdapters
      .filter((adapter) => adapter.name !== 'custom' && (adapter.status === 'degraded' || adapter.status === 'unknown'))
      .map((adapter) => `runtime:${adapter.name}`),
    ...(database.status === 'healthy' ? [] : ['database']),
    ...(grpcStatus.enabled && grpcStatus.status !== 'healthy' ? ['grpc'] : []),
    ...(watchReliability.status === 'degraded' ? ['watch_reliability'] : []),
    ...(agentRunIngestion.status === 'degraded' ? ['agentrun_ingestion'] : []),
    ...(isWorkflowsDataUnavailable || isWorkflowsWarning || isWorkflowsDegraded ? ['workflows'] : []),
    ...(isWorkflowsDataUnknown || isWorkflowsDegraded ? ['runtime:workflows'] : []),
    ...(rolloutHealth.status === 'degraded' ? ['rollout_health'] : []),
    ...(empiricalServices.forecast.status === 'degraded' ? ['empirical:forecast'] : []),
    ...(empiricalServices.lean.status === 'degraded' ? ['empirical:lean'] : []),
    ...(empiricalServices.jobs.status === 'degraded' ? ['empirical:jobs'] : []),
    ...(executionTrust.executionTrust.status !== 'healthy' ? ['execution_trust'] : []),
    ...runtimeAdmission.runtimeKits
      .filter((kit) => kit.decision !== 'healthy')
      .map((kit) => `runtime_kit:${kit.kit_class}`),
  ]

  return {
    service: options.service ?? 'jangar',
    generated_at: now.toISOString(),
    leader_election: {
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
    },
    controllers: effectiveControllers,
    runtime_adapters: effectiveRuntimeAdapters,
    execution_trust: executionTrust.executionTrust,
    database,
    grpc: grpcStatus,
    watch_reliability: {
      status: watchReliability.status,
      window_minutes: watchReliability.window_minutes,
      observed_streams: watchReliability.observed_streams,
      total_events: watchReliability.total_events,
      total_errors: watchReliability.total_errors,
      total_restarts: watchReliability.total_restarts,
      streams: watchReliability.streams,
    },
    agentrun_ingestion: agentRunIngestion,
    runtime_kits: runtimeAdmission.runtimeKits,
    admission_passports: runtimeAdmission.admissionPassports,
    serving_passport_id: runtimeAdmission.servingPassportId,
    rollout_health: rolloutHealth,
    swarms: executionTrust.swarms,
    stages: executionTrust.stages,
    workflows,
    dependency_quorum: dependencyQuorum,
    empirical_services: empiricalServices,
    namespaces: [
      {
        namespace: options.namespace,
        status: degradedComponents.length === 0 ? 'healthy' : 'degraded',
        degraded_components: degradedComponents,
      },
    ],
  }
}
