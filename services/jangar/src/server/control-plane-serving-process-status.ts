import type { AgentRunIngestionStatus, ControllerStatus } from '~/server/control-plane-status-types'
import type { AgentsControllerHealthSnapshot } from '~/server/agents-control-plane-client'

type ControllerHealth = AgentsControllerHealthSnapshot

const buildDefaultIngestion = (namespace: string) => ({
  namespace,
  lastWatchEventAt: null,
  lastResyncAt: null,
  untouchedRunCount: 0,
  oldestUntouchedAgeSeconds: null,
})

export const buildAgentRunIngestionStatus = (
  namespace: string,
  health: ControllerHealth,
  reasonCodes: string[] = [],
): AgentRunIngestionStatus => {
  const entry =
    health.agentRunIngestion?.find((item) => item.namespace === namespace) ?? buildDefaultIngestion(namespace)
  const degraded = reasonCodes.includes('agentrun_ingestion_not_ready')
  const status = degraded ? 'degraded' : health.started ? 'healthy' : 'unknown'

  return {
    namespace,
    status,
    message: degraded
      ? 'AgentRun ingestion not ready according to Agents service'
      : health.started
        ? 'AgentRun ingestion healthy'
        : 'agents controller not started',
    last_watch_event_at: entry.lastWatchEventAt,
    last_resync_at: entry.lastResyncAt,
    untouched_run_count: entry.untouchedRunCount,
    oldest_untouched_age_seconds: entry.oldestUntouchedAgeSeconds,
  }
}

export const buildServingProcessControllerStatus = (
  namespace: string,
  health: ControllerHealth,
  now: Date,
): ControllerStatus => {
  const status =
    health.started && health.crdsReady !== false
      ? 'healthy'
      : health.crdsReady === false
        ? 'degraded'
        : health.enabled
          ? 'unknown'
          : 'disabled'

  return {
    name: 'agents-controller',
    enabled: health.enabled,
    started: health.started,
    scope_namespaces: Array.isArray(health.namespaces) ? health.namespaces : [],
    crds_ready: health.crdsReady === true,
    missing_crds: health.missingCrds,
    last_checked_at: health.lastCheckedAt ?? '',
    status,
    message:
      status === 'healthy'
        ? 'serving process controller state is current'
        : status === 'disabled'
          ? 'serving process controller disabled'
          : status === 'degraded'
            ? 'serving process controller degraded'
            : 'serving process controller not started',
    authority: {
      mode: 'local',
      namespace,
      source_deployment: '',
      source_pod: '',
      observed_at: now.toISOString(),
      fresh: true,
      message: 'serving process local controller state',
    },
  }
}
