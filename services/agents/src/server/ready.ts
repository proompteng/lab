import type { AgentRunIngestionStatus } from '@proompteng/agent-contracts/control-plane-status'

export type AgentRunIngestionHealth = {
  namespace: string
  lastWatchEventAt: string | null
  lastResyncAt: string | null
  untouchedRunCount: number
  oldestUntouchedAgeSeconds: number | null
}

export type AgentRunIngestionAssessment = AgentRunIngestionHealth & {
  status: 'healthy' | 'degraded' | 'unknown'
  message: string
  dispatchPaused: boolean
}

export type AgentsControllerHealthState = {
  enabled: boolean
  started: boolean
  namespaces: string[] | null
  crdsReady: boolean | null
  missingCrds: string[]
  forbiddenCrds?: string[]
  lastCheckedAt: string | null
  agentRunIngestion?: AgentRunIngestionHealth[]
}

export type AgentsLeaderElectionStatus = {
  required: boolean
  isLeader: boolean
  lastAttemptAt: string | null
  lastError: string | null
}

export type AgentsReadyResponseInput = {
  leaderElection: AgentsLeaderElectionStatus
  agentsController: AgentsControllerHealthState
  orchestrationController: AgentsControllerHealthState
  supportingController: AgentsControllerHealthState
  assessAgentRunIngestion: (namespace: string, health: AgentsControllerHealthState) => AgentRunIngestionAssessment
}

export type AgentsReadyHandlerDependencies = Omit<
  AgentsReadyResponseInput,
  'leaderElection' | 'agentsController' | 'orchestrationController' | 'supportingController'
> & {
  getLeaderElectionStatus: () => AgentsLeaderElectionStatus
  getAgentsControllerHealth: () => AgentsControllerHealthState
  getOrchestrationControllerHealth: () => AgentsControllerHealthState
  getSupportingControllerHealth: () => AgentsControllerHealthState
}

export const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.length > 0))]

export const isControllerHealthReady = (health: Pick<AgentsControllerHealthState, 'enabled' | 'crdsReady'>) =>
  !health.enabled || health.crdsReady !== false

export const isAgentRunIngestionReady = (
  health: AgentsControllerHealthState,
  assessAgentRunIngestion: AgentsReadyResponseInput['assessAgentRunIngestion'],
) => {
  if (!health.enabled) return true
  if (!health.started) return false
  const namespaces = health.namespaces?.length ? health.namespaces : ['agents']
  return namespaces.every((namespace) => assessAgentRunIngestion(namespace, health).status !== 'degraded')
}

export const isStandbyLeaderElectionReady = (
  leaderElection: Pick<AgentsLeaderElectionStatus, 'lastAttemptAt' | 'lastError'>,
) => leaderElection.lastAttemptAt !== null && leaderElection.lastError === null

export const buildReadinessReasonCodes = (input: {
  controllersOk: boolean
  leaderElectionReady: boolean
  agentsControllerHealthy: boolean
  memoryProviderReady?: boolean
  servingPassportReady?: boolean
  agentsController: Pick<AgentsControllerHealthState, 'crdsReady' | 'missingCrds' | 'forbiddenCrds'>
  orchestrationController: Pick<AgentsControllerHealthState, 'crdsReady' | 'missingCrds' | 'forbiddenCrds'>
  supportingController: Pick<AgentsControllerHealthState, 'crdsReady' | 'missingCrds' | 'forbiddenCrds'>
}) =>
  uniqueStrings([
    ...(input.controllersOk ? [] : ['controller_crd_check_failed']),
    ...(input.leaderElectionReady ? [] : ['leader_election_not_ready']),
    ...(input.agentsControllerHealthy ? [] : ['agentrun_ingestion_not_ready']),
    ...(input.memoryProviderReady === false ? ['memory_provider_blocked'] : []),
    ...(input.servingPassportReady === false ? ['serving_passport_not_ready'] : []),
    ...(input.agentsController.crdsReady === false
      ? input.agentsController.missingCrds.map((name) => `missing_agents_controller_crd:${name}`)
      : []),
    ...(input.agentsController.crdsReady === false
      ? (input.agentsController.forbiddenCrds ?? []).map((name) => `forbidden_agents_controller_crd:${name}`)
      : []),
    ...(input.orchestrationController.crdsReady === false
      ? input.orchestrationController.missingCrds.map((name) => `missing_orchestration_controller_crd:${name}`)
      : []),
    ...(input.orchestrationController.crdsReady === false
      ? (input.orchestrationController.forbiddenCrds ?? []).map(
          (name) => `forbidden_orchestration_controller_crd:${name}`,
        )
      : []),
    ...(input.supportingController.crdsReady === false
      ? input.supportingController.missingCrds.map((name) => `missing_supporting_controller_crd:${name}`)
      : []),
    ...(input.supportingController.crdsReady === false
      ? (input.supportingController.forbiddenCrds ?? []).map((name) => `forbidden_supporting_controller_crd:${name}`)
      : []),
  ])

const buildStandbyAgentRunIngestionStatus = (
  namespace: string,
  health: AgentsControllerHealthState,
): AgentRunIngestionStatus => {
  const entry = health.agentRunIngestion?.find((item) => item.namespace === namespace)
  return {
    namespace,
    status: 'unknown',
    message: 'AgentRun ingestion is owned by the active controller leader',
    last_watch_event_at: entry?.lastWatchEventAt ?? null,
    last_resync_at: entry?.lastResyncAt ?? null,
    untouched_run_count: entry?.untouchedRunCount ?? 0,
    oldest_untouched_age_seconds: entry?.oldestUntouchedAgeSeconds ?? null,
  }
}

const toAgentRunIngestionStatus = (assessment: AgentRunIngestionAssessment): AgentRunIngestionStatus => ({
  namespace: assessment.namespace,
  status: assessment.status,
  message: assessment.message,
  last_watch_event_at: assessment.lastWatchEventAt,
  last_resync_at: assessment.lastResyncAt,
  untouched_run_count: assessment.untouchedRunCount,
  oldest_untouched_age_seconds: assessment.oldestUntouchedAgeSeconds,
})

export const buildAgentRunIngestionStatuses = (input: {
  namespaces: string[]
  agentsController: AgentsControllerHealthState
  activeControllerReplica: boolean
  assessAgentRunIngestion: AgentsReadyResponseInput['assessAgentRunIngestion']
}): AgentRunIngestionStatus[] =>
  input.namespaces.map((namespace) =>
    input.activeControllerReplica
      ? toAgentRunIngestionStatus(input.assessAgentRunIngestion(namespace, input.agentsController))
      : buildStandbyAgentRunIngestionStatus(namespace, input.agentsController),
  )

export const buildAgentsRuntimeReadyResponse = (input: AgentsReadyResponseInput) => {
  const namespaces = input.agentsController.namespaces?.length ? input.agentsController.namespaces : ['agents']
  const controllersOk =
    isControllerHealthReady(input.agentsController) &&
    isControllerHealthReady(input.orchestrationController) &&
    isControllerHealthReady(input.supportingController)
  const activeControllerReplica = !input.leaderElection.required || input.leaderElection.isLeader
  const leaderElectionReady = activeControllerReplica || isStandbyLeaderElectionReady(input.leaderElection)
  const agentsControllerHealthy = activeControllerReplica
    ? isAgentRunIngestionReady(input.agentsController, input.assessAgentRunIngestion)
    : leaderElectionReady
  const agentRunIngestion = buildAgentRunIngestionStatuses({
    namespaces,
    agentsController: input.agentsController,
    activeControllerReplica,
    assessAgentRunIngestion: input.assessAgentRunIngestion,
  })
  const httpReady = controllersOk && leaderElectionReady
  const status = httpReady && agentsControllerHealthy ? 'ok' : 'degraded'
  const reasonCodes = buildReadinessReasonCodes({
    controllersOk,
    leaderElectionReady,
    agentsControllerHealthy,
    agentsController: input.agentsController,
    orchestrationController: input.orchestrationController,
    supportingController: input.supportingController,
  })

  const body = JSON.stringify({
    schemaVersion: 'agents.proompteng.ai/ready/v1',
    status,
    service: 'agents' as const,
    httpReady,
    reason_codes: reasonCodes,
    namespaces,
    agentrun_ingestion: agentRunIngestion,
    leaderElection: input.leaderElection,
    agentsController: input.agentsController,
    orchestrationController: input.orchestrationController,
    supportingController: input.supportingController,
  })

  return new Response(body, {
    status: httpReady ? 200 : 503,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

export const createAgentsReadyHandler = (deps: AgentsReadyHandlerDependencies) => () =>
  buildAgentsRuntimeReadyResponse({
    leaderElection: deps.getLeaderElectionStatus(),
    agentsController: deps.getAgentsControllerHealth(),
    orchestrationController: deps.getOrchestrationControllerHealth(),
    supportingController: deps.getSupportingControllerHealth(),
    assessAgentRunIngestion: deps.assessAgentRunIngestion,
  })
