import { assessAgentRunIngestion, getAgentsControllerHealth } from '~/server/agents-controller'
import type { AgentRunIngestionStatus, ControllerStatus } from '~/server/control-plane-status-types'

type ControllerHealth = ReturnType<typeof getAgentsControllerHealth>

export const buildAgentRunIngestionStatus = (namespace: string, health: ControllerHealth): AgentRunIngestionStatus => {
  const assessment = assessAgentRunIngestion(namespace, health)

  return {
    namespace,
    status: assessment.status,
    message: assessment.message,
    last_watch_event_at: assessment.lastWatchEventAt,
    last_resync_at: assessment.lastResyncAt,
    untouched_run_count: assessment.untouchedRunCount,
    oldest_untouched_age_seconds: assessment.oldestUntouchedAgeSeconds,
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
