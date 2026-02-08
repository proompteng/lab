import { createFileRoute } from '@tanstack/react-router'

import { getAgentsControllerHealth } from '~/server/agents-controller'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'

const isControllerHealthReady = (health: ReturnType<typeof getAgentsControllerHealth>) =>
  !health.enabled || health.crdsReady !== false

export const Route = createFileRoute('/ready')({
  server: {
    handlers: {
      GET: async () => {
        const leaderElection = getLeaderElectionStatus()
        const agentsController = getAgentsControllerHealth()
        const orchestrationController = getOrchestrationControllerHealth()
        const supportingController = getSupportingControllerHealth()

        const controllersOk =
          isControllerHealthReady(agentsController) &&
          isControllerHealthReady(orchestrationController) &&
          isControllerHealthReady(supportingController)
        const ready = controllersOk

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
      },
    },
  },
})
