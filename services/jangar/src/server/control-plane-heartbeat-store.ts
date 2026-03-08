import { sql } from 'kysely'

import { resolveStoreDb, type Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

type Timestamp = string | Date

export type ControlPlaneHeartbeatComponent =
  | 'agents-controller'
  | 'supporting-controller'
  | 'orchestration-controller'
  | 'workflow-runtime'

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

export type ControlPlaneHeartbeatInput = {
  namespace: string
  component: ControlPlaneHeartbeatComponent
  workloadRole: ControlPlaneHeartbeatWorkloadRole
  podName: string
  deploymentName: string
  enabled: boolean
  status: ControlPlaneHeartbeatStatus
  message: string
  leadershipState: ControlPlaneHeartbeatLeadership
  expiresAt?: Timestamp
  observedAt?: Timestamp
}

export type ControlPlaneHeartbeatStoreGetInput = {
  namespace: string
  component: ControlPlaneHeartbeatComponent
  workloadRole?: ControlPlaneHeartbeatWorkloadRole
}

export type ControlPlaneHeartbeatStore = {
  ready: Promise<void>
  close: () => Promise<void>
  upsertHeartbeat: (input: ControlPlaneHeartbeatInput) => Promise<void>
  getHeartbeat: (input: ControlPlaneHeartbeatStoreGetInput) => Promise<ControlPlaneHeartbeatRow | null>
}

type StoreOptions = {
  url?: string
  createDb?: (url: string) => Db
}

const resolveCluster = () => process.env.JANGAR_CONTROL_PLANE_CACHE_CLUSTER?.trim() || 'default'

const toDbText = (value: Timestamp) => {
  if (value instanceof Date) {
    return value.toISOString()
  }
  return value
}

const toHeartbeatStatus = (value: string | null): ControlPlaneHeartbeatStatus => {
  if (value === 'healthy' || value === 'degraded' || value === 'disabled' || value === 'unknown') {
    return value
  }
  return 'unknown'
}

const toLeadership = (value: string | null): ControlPlaneHeartbeatLeadership => {
  if (value === 'leader' || value === 'follower') {
    return value
  }
  return 'not-applicable'
}

const normalizeWorkloadRole = (value: string | null): ControlPlaneHeartbeatWorkloadRole => {
  if (value === 'web' || value === 'controllers') {
    return value
  }
  return 'other'
}

export const resolveControlPlaneHeartbeatTtlSeconds = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_HEARTBEAT_TTL_SECONDS?.trim()
  if (!raw) return 120
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 120
  return parsed
}

export const resolveControlPlaneHeartbeatIntervalSeconds = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_HEARTBEAT_INTERVAL_SECONDS?.trim()
  if (!raw) return 15
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 15
  return parsed
}

export const resolveControlPlanePodIdentity = (): { podName: string; deploymentName: string } => {
  const podName = (process.env.POD_NAME || process.env.HOSTNAME || 'unknown').trim()
  const deploymentName = (
    process.env.JANGAR_DEPLOYMENT_NAME?.trim() ||
    process.env.DEPLOYMENT_NAME?.trim() ||
    process.env.JANGAR_POD_PREFIX?.trim() ||
    podName
  ).trim()

  return {
    podName: podName.length > 0 ? podName : 'unknown',
    deploymentName: deploymentName.length > 0 ? deploymentName : 'unknown',
  }
}

export const resolveHeartbeatSourceNamespace = () =>
  process.env.JANGAR_POD_NAMESPACE?.trim() || process.env.POD_NAMESPACE?.trim() || 'default'

const resolveExpiresAt = (at: Timestamp, ttlSeconds: number) => {
  const base = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(base.getTime())) return new Date()
  return new Date(base.getTime() + ttlSeconds * 1000)
}

export const createControlPlaneHeartbeatStore = (options: StoreOptions = {}): ControlPlaneHeartbeatStore => {
  const resolved = resolveStoreDb(options)
  if (!resolved.db || !resolved.url) {
    throw new Error('DATABASE_URL is required for Jangar control-plane heartbeat store')
  }

  const db = resolved.db
  const ready = ensureMigrations(db)

  const close = async () => {
    if (resolved.shared) return
    await db.destroy()
  }

  const upsertHeartbeat = async (input: ControlPlaneHeartbeatInput) => {
    await ready
    const now = new Date()
    const ttlSeconds = resolveControlPlaneHeartbeatTtlSeconds()
    const observedAt = toDbText(input.observedAt ?? now)
    const expiresAt = toDbText(
      resolveExpiresAt(input.expiresAt ? new Date(input.expiresAt) : new Date(observedAt), ttlSeconds),
    )

    await db
      .insertInto('agents_control_plane.component_heartbeats')
      .values({
        cluster: resolveCluster(),
        namespace: input.namespace,
        component: input.component,
        workload_role: input.workloadRole,
        pod_name: input.podName,
        deployment_name: input.deploymentName,
        enabled: input.enabled,
        status: input.status,
        message: input.message,
        leadership_state: input.leadershipState,
        observed_at: sql`${observedAt}::timestamptz`,
        expires_at: sql`${expiresAt}::timestamptz`,
        source_namespace: resolveHeartbeatSourceNamespace(),
        updated_at: sql`now()`,
      })
      .onConflict((oc) =>
        oc.columns(['cluster', 'namespace', 'component', 'workload_role']).doUpdateSet({
          pod_name: input.podName,
          deployment_name: input.deploymentName,
          enabled: input.enabled,
          status: input.status,
          message: input.message,
          leadership_state: input.leadershipState,
          observed_at: sql`${observedAt}::timestamptz`,
          expires_at: sql`${expiresAt}::timestamptz`,
          source_namespace: resolveHeartbeatSourceNamespace(),
          updated_at: sql`now()`,
        }),
      )
      .execute()
  }

  const getHeartbeat = async (input: ControlPlaneHeartbeatStoreGetInput) => {
    await ready
    const query = db
      .selectFrom('agents_control_plane.component_heartbeats')
      .select([
        'namespace',
        'component',
        'workload_role',
        'pod_name',
        'deployment_name',
        'enabled',
        'status',
        'message',
        'leadership_state',
        'observed_at',
        'expires_at',
      ])
      .where('cluster', '=', resolveCluster())
      .where('namespace', '=', input.namespace)
      .where('component', '=', input.component)
      .orderBy('observed_at', 'desc')

    const filtered = input.workloadRole === undefined ? query : query.where('workload_role', '=', input.workloadRole)
    const row = await filtered.limit(1).executeTakeFirst()
    if (!row) {
      return null
    }

    return {
      namespace: row.namespace,
      component: row.component,
      workload_role: normalizeWorkloadRole(row.workload_role),
      pod_name: row.pod_name,
      deployment_name: row.deployment_name,
      enabled: row.enabled,
      status: toHeartbeatStatus(row.status),
      message: row.message || '',
      leadership_state: toLeadership(row.leadership_state),
      observed_at: row.observed_at,
      expires_at: row.expires_at,
    }
  }

  return { ready, close, upsertHeartbeat, getHeartbeat }
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
