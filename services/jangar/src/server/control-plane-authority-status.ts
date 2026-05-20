import type { AgentsControllerHealthSnapshot } from '@proompteng/agent-contracts/agents-ready'
import { isHeartbeatFresh, type ControlPlaneHeartbeatRow } from '~/server/control-plane-heartbeat-store'
import type { ControllerStatus, RuntimeAdapterStatus } from '~/server/control-plane-status-types'

type ControllerHealth = AgentsControllerHealthSnapshot

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

export const buildLocalControlPlaneAuthority = (namespace: string) => ({
  mode: 'local' as const,
  namespace,
  source_deployment: '',
  source_pod: '',
  observed_at: new Date().toISOString(),
  fresh: true,
  message: 'using local controller state',
})

export const buildControllerStatusFromHeartbeat = ({
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

export const buildRuntimeAdapterStatusFromSource = ({
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
