import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk'
import { sql } from 'kysely'

import { getAgentsControllerHealth } from '~/server/agents-controller'
import { getDb } from '~/server/db'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`

type ControllerHealth = ReturnType<typeof getAgentsControllerHealth>

export type ControllerStatus = {
  name: string
  enabled: boolean
  started: boolean
  scope_namespaces: string[]
  crds_ready: boolean
  missing_crds: string[]
  last_checked_at: string
  status: 'healthy' | 'degraded' | 'disabled' | 'unknown'
  message: string
}

export type RuntimeAdapterStatus = {
  name: string
  available: boolean
  status: 'healthy' | 'configured' | 'degraded' | 'disabled' | 'unknown'
  message: string
  endpoint: string
}

export type DatabaseStatus = {
  configured: boolean
  connected: boolean
  status: 'healthy' | 'degraded' | 'disabled'
  message: string
  latency_ms: number
}

export type GrpcStatus = {
  enabled: boolean
  address: string
  status: 'healthy' | 'degraded' | 'disabled'
  message: string
}

export type NamespaceStatus = {
  namespace: string
  status: 'healthy' | 'degraded'
  degraded_components: string[]
}

export type ControlPlaneStatus = {
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
  database: DatabaseStatus
  grpc: GrpcStatus
  namespaces: NamespaceStatus[]
}

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
  resolveTemporalAdapter?: () => Promise<RuntimeAdapterStatus>
  checkDatabase?: () => Promise<DatabaseStatus>
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const buildControllerStatus = (name: string, health: ControllerHealth): ControllerStatus => {
  const scopeNamespaces = Array.isArray(health.namespaces) ? health.namespaces : []
  if (!health.enabled) {
    return {
      name,
      enabled: false,
      started: health.started,
      scope_namespaces: scopeNamespaces,
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'disabled',
      message: 'controller disabled',
    }
  }
  if (!health.started) {
    return {
      name,
      enabled: true,
      started: false,
      scope_namespaces: scopeNamespaces,
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'degraded',
      message: 'controller not started',
    }
  }
  if (health.crdsReady === false) {
    return {
      name,
      enabled: true,
      started: true,
      scope_namespaces: scopeNamespaces,
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'degraded',
      message: `missing CRDs: ${health.missingCrds.join(', ') || 'unknown'}`,
    }
  }
  if (health.crdsReady === null) {
    return {
      name,
      enabled: true,
      started: true,
      scope_namespaces: scopeNamespaces,
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'unknown',
      message: 'CRD status not yet checked',
    }
  }
  return {
    name,
    enabled: true,
    started: true,
    scope_namespaces: scopeNamespaces,
    crds_ready: true,
    missing_crds: health.missingCrds,
    last_checked_at: health.lastCheckedAt ?? '',
    status: 'healthy',
    message: '',
  }
}

const resolveAdapterFromController = (controllerStatus: string, controllerMessage: string, healthyMessage = '') => {
  if (controllerStatus === 'healthy') {
    return { available: true, status: 'healthy', message: healthyMessage }
  }
  if (controllerStatus === 'unknown') {
    return { available: false, status: 'unknown', message: controllerMessage || 'controller status unknown' }
  }
  if (controllerStatus === 'disabled') {
    return { available: false, status: 'disabled', message: controllerMessage || 'controller disabled' }
  }
  return { available: false, status: 'degraded', message: controllerMessage || 'controller unhealthy' }
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
    }
  } catch (error) {
    return {
      name: 'temporal',
      available: false,
      status: 'degraded',
      message: normalizeMessage(error),
      endpoint: DEFAULT_TEMPORAL_ADDRESS,
    }
  }
}

const checkDatabase = async (): Promise<DatabaseStatus> => {
  const db = getDb()
  if (!db) {
    return {
      configured: false,
      connected: false,
      status: 'disabled',
      message: 'DATABASE_URL not set',
      latency_ms: 0,
    }
  }

  const start = Date.now()
  try {
    await sql`select 1`.execute(db)
    return {
      configured: true,
      connected: true,
      status: 'healthy',
      message: '',
      latency_ms: Math.max(0, Date.now() - start),
    }
  } catch (error) {
    return {
      configured: true,
      connected: false,
      status: 'degraded',
      message: normalizeMessage(error),
      latency_ms: Math.max(0, Date.now() - start),
    }
  }
}

export const buildControlPlaneStatus = async (
  options: ControlPlaneStatusOptions,
  deps: ControlPlaneStatusDeps = {},
): Promise<ControlPlaneStatus> => {
  const agentsHealth = (deps.getAgentsControllerHealth ?? getAgentsControllerHealth)()
  const supportingHealth = (deps.getSupportingControllerHealth ?? getSupportingControllerHealth)()
  const orchestrationHealth = (deps.getOrchestrationControllerHealth ?? getOrchestrationControllerHealth)()

  const agentsController = buildControllerStatus('agents-controller', agentsHealth)
  const supportingController = buildControllerStatus('supporting-controller', supportingHealth)
  const orchestrationController = buildControllerStatus('orchestration-controller', orchestrationHealth)
  const controllers = [agentsController, supportingController, orchestrationController]

  const workflowAdapter = resolveAdapterFromController(
    agentsController.status,
    agentsController.message,
    'native workflow runtime via Kubernetes Jobs',
  )
  const jobAdapter = resolveAdapterFromController(
    agentsController.status,
    agentsController.message,
    'job runtime via Kubernetes Jobs',
  )

  const runtimeAdapters: RuntimeAdapterStatus[] = [
    {
      name: 'workflow',
      available: workflowAdapter.available,
      status: workflowAdapter.status as RuntimeAdapterStatus['status'],
      message: workflowAdapter.message,
      endpoint: '',
    },
    {
      name: 'job',
      available: jobAdapter.available,
      status: jobAdapter.status as RuntimeAdapterStatus['status'],
      message: jobAdapter.message,
      endpoint: '',
    },
    await (deps.resolveTemporalAdapter ?? resolveTemporalAdapter)(),
    {
      name: 'custom',
      available: true,
      status: 'unknown',
      message: 'custom runtime configured per AgentRun',
      endpoint: '',
    },
  ]

  const database = await (deps.checkDatabase ?? checkDatabase)()
  const grpcStatus = options.grpc

  const degradedComponents = [
    ...controllers
      .filter((controller) => controller.status === 'degraded' || controller.status === 'disabled')
      .map((controller) => controller.name),
    ...runtimeAdapters.filter((adapter) => adapter.status === 'degraded').map((adapter) => `runtime:${adapter.name}`),
    ...(database.status === 'healthy' ? [] : ['database']),
    ...(grpcStatus.enabled && grpcStatus.status !== 'healthy' ? ['grpc'] : []),
  ]

  const now = (deps.now ?? (() => new Date()))()
  const leaderElection = getLeaderElectionStatus()

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
    controllers,
    runtime_adapters: runtimeAdapters,
    database,
    grpc: grpcStatus,
    namespaces: [
      {
        namespace: options.namespace,
        status: degradedComponents.length === 0 ? 'healthy' : 'degraded',
        degraded_components: degradedComponents,
      },
    ],
  }
}
