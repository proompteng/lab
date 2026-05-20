import { getAgentsReadySnapshot } from '@proompteng/agent-contracts/agents-ready'
import type { AgentRunIngestionStatus } from '@proompteng/agent-contracts/control-plane-status'

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

const normalizeAgentRunIngestionHealth = (
  namespace: string,
  value: AgentRunIngestionStatus | undefined,
): AgentRunIngestionHealth | null => {
  if (!value) return null
  const entryNamespace = value.namespace || namespace
  if (entryNamespace !== namespace) return null
  return {
    namespace,
    lastWatchEventAt: value.last_watch_event_at,
    lastResyncAt: value.last_resync_at,
    untouchedRunCount: value.untouched_run_count,
    oldestUntouchedAgeSeconds: value.oldest_untouched_age_seconds,
  }
}

export const assessAgentRunIngestionViaAgentsService = async (
  namespace: string,
): Promise<AgentRunIngestionAssessment> => {
  try {
    const snapshot = await getAgentsReadySnapshot()
    if (!snapshot.available) {
      return defaultAgentRunIngestionAssessment(namespace, {
        message: snapshot.error
          ? `Agents readiness unavailable: ${snapshot.error}`
          : 'Agents readiness endpoint is not ready',
      })
    }

    const entry =
      snapshot.agentRunIngestion
        .map((item) => normalizeAgentRunIngestionHealth(namespace, item))
        .find((item) => item !== null) ?? defaultAgentRunIngestionAssessment(namespace)
    const ingestionNotReady =
      snapshot.reasonCodes.includes(AGENTRUN_INGESTION_NOT_READY_REASON) ||
      snapshot.agentRunIngestion.some((item) => item.namespace === namespace && item.status === 'degraded')
    if (ingestionNotReady) {
      return {
        ...entry,
        status: 'degraded',
        message: 'AgentRun ingestion not ready according to Agents service',
        dispatchPaused: true,
      }
    }

    if (!snapshot.agentsController.started) {
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
