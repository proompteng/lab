import { createFileRoute } from '@tanstack/react-router'

import { assessAgentRunIngestion, getAgentsControllerHealth } from '~/server/agents-controller'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'

const isControllerHealthReady = (health: ReturnType<typeof getAgentsControllerHealth>) =>
  !health.enabled || health.crdsReady !== false

const isAgentRunIngestionReady = (health: ReturnType<typeof getAgentsControllerHealth>) => {
  if (!health.enabled) return true
  if (!health.started) return false
  const namespaces = health.namespaces?.length ? health.namespaces : ['agents']
  return namespaces.every((namespace) => assessAgentRunIngestion(namespace, health).status !== 'degraded')
}

const isStandbyLeaderElectionReady = (leaderElection: ReturnType<typeof getLeaderElectionStatus>) =>
  leaderElection.lastAttemptAt !== null && leaderElection.lastError === null

export const Route = createFileRoute('/ready')({
  server: {
    handlers: {
      GET: () => getReadyHandler(),
    },
  },
})

export const getReadyHandler = async () => {
  const leaderElection = getLeaderElectionStatus()
  const agentsController = getAgentsControllerHealth()
  const orchestrationController = getOrchestrationControllerHealth()
  const supportingController = getSupportingControllerHealth()

  const controllersOk =
    isControllerHealthReady(agentsController) &&
    isControllerHealthReady(orchestrationController) &&
    isControllerHealthReady(supportingController)
  const leaderRequired = leaderElection.required
  const activeControllerReplica = !leaderRequired || leaderElection.isLeader
  const leaderElectionReady = activeControllerReplica || isStandbyLeaderElectionReady(leaderElection)
  const agentsControllerReady = activeControllerReplica
    ? isAgentRunIngestionReady(agentsController)
    : leaderElectionReady
  const ready = controllersOk && agentsControllerReady

  const body = JSON.stringify({
    status: ready ? 'ok' : 'degraded',
    service: 'jangar' as const,
    leaderElection,
    agentsController,
    orchestrationController,
    supportingController,
  })

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
  }

  return new Response(body, {
    status: ready ? 200 : 503,
    headers,
  })
}
