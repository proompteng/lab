import { getAgentsControllerHealth } from './agents-controller'
import type { GrpcStatus } from './control-plane-grpc'
import { getOrchestrationControllerHealth } from './orchestration-controller'
import { resolveRuntimeServiceName } from './runtime-identity'
import { getSupportingControllerHealth } from './supporting-primitives-controller'

type ControllerHealthSnapshot = {
  enabled: boolean
  started: boolean
  crdsReady: boolean | null
  missingCrds: string[]
  lastCheckedAt: string | null
}

export type AgentsControlPlaneStatus = {
  service: string
  generated_at: string
  controllers: Array<ReturnType<typeof buildControllerStatus>>
  runtime_adapters: unknown[]
  database: {
    configured: boolean
    connected: boolean
    status: 'disabled' | 'unknown'
    message: string
    latency_ms: number
  }
  grpc: GrpcStatus
  namespaces: Array<{
    namespace: string
    status: 'unknown'
    degraded_components: string[]
  }>
}

const buildControllerStatus = (name: string, health: ControllerHealthSnapshot) => ({
  name,
  enabled: health.enabled,
  started: health.started,
  crds_ready: health.crdsReady === true,
  missing_crds: health.missingCrds,
  last_checked_at: health.lastCheckedAt ?? '',
  status: health.enabled ? (health.started && health.crdsReady !== false ? 'healthy' : 'degraded') : 'disabled',
  message: health.enabled
    ? health.crdsReady === false
      ? `missing CRDs: ${health.missingCrds.join(', ')}`
      : ''
    : 'disabled',
})

export const buildAgentsControlPlaneStatus = (input: {
  namespace: string
  grpc: GrpcStatus
  service?: string
  now?: Date
}): AgentsControlPlaneStatus => ({
  service: input.service ?? resolveRuntimeServiceName(),
  generated_at: (input.now ?? new Date()).toISOString(),
  controllers: [
    buildControllerStatus('agents-controller', getAgentsControllerHealth()),
    buildControllerStatus('orchestration-controller', getOrchestrationControllerHealth()),
    buildControllerStatus('supporting-controller', getSupportingControllerHealth()),
  ],
  runtime_adapters: [],
  database: {
    configured: Boolean(process.env.DATABASE_URL),
    connected: false,
    status: process.env.DATABASE_URL ? 'unknown' : 'disabled',
    message: process.env.DATABASE_URL ? 'database connectivity is reported by API calls' : 'DATABASE_URL is not set',
    latency_ms: 0,
  },
  grpc: input.grpc,
  namespaces: [
    {
      namespace: input.namespace,
      status: 'unknown',
      degraded_components: [],
    },
  ],
})
