import { resolveControlPlaneHeartbeatConfig } from '~/server/control-plane-config'

type Timestamp = string | Date

export type ControlPlaneHeartbeatWorkloadRole = 'web' | 'controllers' | 'other'

export type ControlPlaneHeartbeatStatus = 'healthy' | 'degraded' | 'disabled' | 'unknown'

export type ControlPlaneHeartbeatLeadership = 'leader' | 'follower' | 'not-applicable'

export type ControlPlaneHeartbeatRow = {
  namespace: string
  component: string
  workload_role: ControlPlaneHeartbeatWorkloadRole
  pod_name: string
  deployment_name: string
  enabled: boolean
  status: ControlPlaneHeartbeatStatus
  message: string
  leadership_state: ControlPlaneHeartbeatLeadership
  observed_at: Timestamp | null
  expires_at: Timestamp | null
}

export const resolveControlPlaneHeartbeatTtlSeconds = () => resolveControlPlaneHeartbeatConfig(process.env).ttlSeconds

export const resolveControlPlaneHeartbeatIntervalSeconds = () =>
  resolveControlPlaneHeartbeatConfig(process.env).intervalSeconds

export const resolveControlPlanePodIdentity = (): { podName: string; deploymentName: string } => {
  const config = resolveControlPlaneHeartbeatConfig(process.env)

  return {
    podName: config.podName,
    deploymentName: config.deploymentName,
  }
}

export const isHeartbeatFresh = (row: { observed_at: Timestamp | null; expires_at: Timestamp | null }, now: Date) => {
  const observed = row.observed_at ? new Date(row.observed_at) : null
  const expires = row.expires_at ? new Date(row.expires_at) : null
  if (!observed || !Number.isFinite(observed.getTime())) return false
  if (!expires || !Number.isFinite(expires.getTime())) return false
  return observed.getTime() <= now.getTime() && now.getTime() <= expires.getTime()
}

export const heartbeatIsKnown = (row: ControlPlaneHeartbeatRow | null) =>
  row !== null && row.component.length > 0 && row.namespace.length > 0
