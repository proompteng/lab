import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk'
import { sql } from 'kysely'
import { getAgentsControllerHealth } from '~/server/agents-controller'
import { getDb } from '~/server/db'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`

type ControllerHealth = ReturnType<typeof getAgentsControllerHealth>

type RuntimeAdapterStatus = {
  name: string
  available: boolean
  status: string
  message: string
  endpoint: string
}

type DatabaseStatus = {
  configured: boolean
  connected: boolean
  status: string
  message: string
  latency_ms: number
}

type GrpcStatus = {
  enabled: boolean
  address: string
  status: string
  message: string
}

type ControlPlaneStatusOptions = {
  namespace: string
  grpc: GrpcStatus
  service?: string
}

type ControlPlaneStatusDeps = {
  getAgentsControllerHealth?: typeof getAgentsControllerHealth
  getSupportingControllerHealth?: typeof getSupportingControllerHealth
  getOrchestrationControllerHealth?: typeof getOrchestrationControllerHealth
  resolveTemporalAdapter?: () => Promise<RuntimeAdapterStatus>
  checkDatabase?: () => Promise<DatabaseStatus>
  now?: () => Date
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const buildControllerStatus = (name: string, health: ControllerHealth) => {
  if (!health.enabled) {
    return {
      name,
      enabled: false,
      started: health.started,
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
    crds_ready: true,
    missing_crds: health.missingCrds,
    last_checked_at: health.lastCheckedAt ?? '',
    status: 'healthy',
    message: '',
  }
}

const resolveAdapterFromController = (controllerStatus: string, controllerMessage: string) => {
  if (controllerStatus === 'healthy') {
    return { available: true, status: 'healthy', message: '' }
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
) => {
  const agentsHealth = (deps.getAgentsControllerHealth ?? getAgentsControllerHealth)()
  const supportingHealth = (deps.getSupportingControllerHealth ?? getSupportingControllerHealth)()
  const orchestrationHealth = (deps.getOrchestrationControllerHealth ?? getOrchestrationControllerHealth)()

  const agentsController = buildControllerStatus('agents-controller', agentsHealth)
  const supportingController = buildControllerStatus('supporting-controller', supportingHealth)
  const orchestrationController = buildControllerStatus('orchestration-controller', orchestrationHealth)
  const controllers = [agentsController, supportingController, orchestrationController]

  const workflowAdapter = resolveAdapterFromController(agentsController.status, agentsController.message)
  const jobAdapter = resolveAdapterFromController(agentsController.status, agentsController.message)

  const runtimeAdapters = [
    {
      name: 'workflow',
      available: workflowAdapter.available,
      status: workflowAdapter.status,
      message: workflowAdapter.message,
      endpoint: '',
    },
    {
      name: 'job',
      available: jobAdapter.available,
      status: jobAdapter.status,
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
    ...runtimeAdapters
      .filter((adapter) => adapter.status === 'degraded')
      .map((adapter) => `runtime:${adapter.name}`),
    ...(database.status === 'healthy' ? [] : ['database']),
    ...(grpcStatus.status === 'healthy' ? [] : ['grpc']),
  ]

  const now = (deps.now ?? (() => new Date()))()

  return {
    service: options.service ?? 'jangar',
    generated_at: now.toISOString(),
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
