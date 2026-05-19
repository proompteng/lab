import { fetchAgentsServiceJson } from '~/server/agents-service-client'

export type AgentsControllerHealthSnapshot = {
  enabled: boolean
  started: boolean
  namespaces: string[] | null
  crdsReady: boolean | null
  missingCrds: string[]
  lastCheckedAt: string | null
  agentRunIngestion?: Array<{
    namespace: string
    lastWatchEventAt: string | null
    lastResyncAt: string | null
    untouchedRunCount: number
    oldestUntouchedAgeSeconds: number | null
  }>
}

export type AgentsLeaderElectionSnapshot = {
  required: boolean
  isLeader: boolean
  lastAttemptAt: string | null
  lastError: string | null
  [key: string]: unknown
}

export type AgentsReadyPayload = {
  schemaVersion?: string
  status?: 'ok' | 'degraded'
  service?: 'agents' | string
  httpReady?: boolean
  reason_codes?: string[]
  namespaces?: string[]
  leaderElection?: AgentsLeaderElectionSnapshot
  agentsController?: AgentsControllerHealthSnapshot
  orchestrationController?: AgentsControllerHealthSnapshot
  supportingController?: AgentsControllerHealthSnapshot
}

export type AgentsReadySnapshot = {
  available: boolean
  httpStatus: number
  status: 'ok' | 'degraded'
  httpReady: boolean
  reasonCodes: string[]
  namespaces: string[]
  leaderElection: AgentsLeaderElectionSnapshot
  agentsController: AgentsControllerHealthSnapshot
  orchestrationController: AgentsControllerHealthSnapshot
  supportingController: AgentsControllerHealthSnapshot
  raw: AgentsReadyPayload
  error: string | null
}

export const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.length > 0))]

const fallbackController = (namespace = 'agents'): AgentsControllerHealthSnapshot => ({
  enabled: true,
  started: false,
  namespaces: [namespace],
  crdsReady: false,
  missingCrds: [],
  lastCheckedAt: null,
  agentRunIngestion: [],
})

const fallbackLeaderElection = (error: string | null): AgentsLeaderElectionSnapshot => ({
  required: true,
  isLeader: false,
  lastAttemptAt: null,
  lastError: error ?? 'Agents service readiness unavailable',
})

const normalizeStatus = (value: unknown): 'ok' | 'degraded' => (value === 'ok' ? 'ok' : 'degraded')

const normalizeController = (
  value: AgentsControllerHealthSnapshot | undefined,
  namespace: string,
): AgentsControllerHealthSnapshot => {
  if (!value || typeof value !== 'object') return fallbackController(namespace)
  return {
    enabled: Boolean(value.enabled),
    started: Boolean(value.started),
    namespaces: Array.isArray(value.namespaces) ? value.namespaces.filter((item) => typeof item === 'string') : null,
    crdsReady:
      typeof value.crdsReady === 'boolean' || value.crdsReady === null || value.crdsReady === undefined
        ? (value.crdsReady ?? null)
        : false,
    missingCrds: Array.isArray(value.missingCrds) ? value.missingCrds.filter((item) => typeof item === 'string') : [],
    lastCheckedAt: typeof value.lastCheckedAt === 'string' ? value.lastCheckedAt : null,
    agentRunIngestion: Array.isArray(value.agentRunIngestion) ? value.agentRunIngestion : [],
  }
}

const normalizeLeaderElection = (
  value: AgentsLeaderElectionSnapshot | undefined,
  error: string | null,
): AgentsLeaderElectionSnapshot => {
  if (!value || typeof value !== 'object') return fallbackLeaderElection(error)
  return {
    ...value,
    required: Boolean(value.required),
    isLeader: Boolean(value.isLeader),
    lastAttemptAt: typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
  }
}

export const isControllerHealthReady = (health: Pick<AgentsControllerHealthSnapshot, 'enabled' | 'crdsReady'>) =>
  !health.enabled || health.crdsReady !== false

export const buildAgentsReadySnapshot = (input: {
  payload: AgentsReadyPayload | null
  httpStatus: number
  error?: string | null
}): AgentsReadySnapshot => {
  const payload = input.payload ?? {}
  const error = input.error ?? null
  const status = normalizeStatus(payload.status)
  const agentsController = normalizeController(payload.agentsController, 'agents')
  const namespaces = uniqueStrings(
    payload.namespaces?.length
      ? payload.namespaces
      : agentsController.namespaces?.length
        ? agentsController.namespaces
        : ['agents'],
  )
  const primaryNamespace = namespaces[0] ?? 'agents'
  const leaderElection = normalizeLeaderElection(payload.leaderElection, error)
  const orchestrationController = normalizeController(payload.orchestrationController, primaryNamespace)
  const supportingController = normalizeController(payload.supportingController, primaryNamespace)
  const raw: AgentsReadyPayload = {
    schemaVersion: payload.schemaVersion ?? 'agents.proompteng.ai/ready/v1',
    status,
    service: payload.service ?? 'agents',
    httpReady: payload.httpReady ?? false,
    reason_codes: Array.isArray(payload.reason_codes) ? payload.reason_codes : [],
    namespaces,
    leaderElection,
    agentsController,
    orchestrationController,
    supportingController,
  }

  return {
    available: input.payload !== null,
    httpStatus: input.httpStatus,
    status,
    httpReady: raw.httpReady ?? false,
    reasonCodes: raw.reason_codes ?? [],
    namespaces,
    leaderElection,
    agentsController,
    orchestrationController,
    supportingController,
    raw,
    error,
  }
}

export const getAgentsReadySnapshot = async (): Promise<AgentsReadySnapshot> => {
  const result = await fetchAgentsServiceJson<AgentsReadyPayload>('/ready')
  return buildAgentsReadySnapshot({
    payload: result.body,
    httpStatus: result.status,
    error: result.ok ? null : result.error,
  })
}

export type AgentsControllerHealthSnapshotDeps = {
  getAgentsReadySnapshot?: () => Promise<AgentsReadySnapshot>
  getAgentsControllerHealth?: () => AgentsControllerHealthSnapshot
  getSupportingControllerHealth?: () => AgentsControllerHealthSnapshot
  getOrchestrationControllerHealth?: () => AgentsControllerHealthSnapshot
}

export const resolveAgentsControllerHealthSnapshots = async (deps: AgentsControllerHealthSnapshotDeps = {}) => {
  let snapshot: AgentsReadySnapshot | null = null
  const resolveSnapshot = async (): Promise<AgentsReadySnapshot> => {
    snapshot ??= await (deps.getAgentsReadySnapshot ?? getAgentsReadySnapshot)()
    return snapshot
  }
  const readySnapshot = await resolveSnapshot()

  return {
    reasonCodes: readySnapshot.reasonCodes,
    agentsHealth: deps.getAgentsControllerHealth ? deps.getAgentsControllerHealth() : readySnapshot.agentsController,
    supportingHealth: deps.getSupportingControllerHealth
      ? deps.getSupportingControllerHealth()
      : readySnapshot.supportingController,
    orchestrationHealth: deps.getOrchestrationControllerHealth
      ? deps.getOrchestrationControllerHealth()
      : readySnapshot.orchestrationController,
  }
}
