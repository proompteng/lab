import { resolveAgentsServiceBaseUrl } from '~/server/agents-service-proxy'
import { asRecord, asString } from '~/server/primitives-http'

const AGENTRUN_INGESTION_NOT_READY_REASON = 'agentrun_ingestion_not_ready'

type AgentRunIngestionHealth = {
  namespace: string
  lastWatchEventAt: string | null
  lastResyncAt: string | null
  untouchedRunCount: number
  oldestUntouchedAgeSeconds: number | null
}

type AgentRunIngestionAssessment = AgentRunIngestionHealth & {
  status: 'healthy' | 'degraded' | 'unknown'
  message: string
  dispatchPaused: boolean
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const defaultAgentRunIngestionAssessment = (
  namespace: string,
  overrides: Partial<AgentRunIngestionAssessment> = {},
): AgentRunIngestionAssessment => ({
  namespace,
  lastWatchEventAt: null,
  lastResyncAt: null,
  untouchedRunCount: 0,
  oldestUntouchedAgeSeconds: null,
  status: 'unknown',
  message: 'AgentRun ingestion status unavailable',
  dispatchPaused: false,
  ...overrides,
})

const normalizeAgentRunIngestionHealth = (namespace: string, value: unknown): AgentRunIngestionHealth | null => {
  const record = asRecord(value)
  if (!record) return null
  const entryNamespace = asString(record.namespace) ?? namespace
  if (entryNamespace !== namespace) return null
  const untouchedRunCount = typeof record.untouchedRunCount === 'number' ? record.untouchedRunCount : 0
  const oldestUntouchedAgeSeconds =
    typeof record.oldestUntouchedAgeSeconds === 'number' ? record.oldestUntouchedAgeSeconds : null
  return {
    namespace,
    lastWatchEventAt: asString(record.lastWatchEventAt),
    lastResyncAt: asString(record.lastResyncAt),
    untouchedRunCount,
    oldestUntouchedAgeSeconds,
  }
}

const readAgentsReadyPayload = async () => {
  const url = new URL('/ready', `${resolveAgentsServiceBaseUrl()}/`)
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-agents-client': 'jangar',
    },
  })
  const payload = asRecord(await response.json().catch(() => null))
  return { ok: response.ok, payload }
}

export const assessAgentRunIngestionViaAgentsService = async (
  namespace: string,
): Promise<AgentRunIngestionAssessment> => {
  try {
    const { ok, payload } = await readAgentsReadyPayload()
    const agentsController = asRecord(payload?.agentsController)
    if (!payload || !agentsController) {
      return defaultAgentRunIngestionAssessment(namespace, {
        message: ok
          ? 'Agents readiness payload did not include AgentRun ingestion status'
          : 'Agents readiness endpoint is not ready',
      })
    }

    const reasonCodes = Array.isArray(payload.reason_codes)
      ? payload.reason_codes.filter((reason): reason is string => typeof reason === 'string')
      : []
    const entries = Array.isArray(agentsController.agentRunIngestion) ? agentsController.agentRunIngestion : []
    const entry =
      entries.map((item) => normalizeAgentRunIngestionHealth(namespace, item)).find((item) => item !== null) ??
      defaultAgentRunIngestionAssessment(namespace)
    const ingestionNotReady = reasonCodes.includes(AGENTRUN_INGESTION_NOT_READY_REASON)
    if (ingestionNotReady) {
      return {
        ...entry,
        status: 'degraded',
        message: 'AgentRun ingestion not ready according to Agents service',
        dispatchPaused: true,
      }
    }

    const started = agentsController.started === true
    if (!started) {
      return {
        ...entry,
        status: 'unknown',
        message: 'agents controller not started',
        dispatchPaused: false,
      }
    }

    return {
      ...entry,
      status: 'healthy',
      message: 'AgentRun ingestion healthy',
      dispatchPaused: false,
    }
  } catch (error) {
    return defaultAgentRunIngestionAssessment(namespace, {
      message: `Agents readiness unavailable: ${normalizeMessage(error)}`,
    })
  }
}
