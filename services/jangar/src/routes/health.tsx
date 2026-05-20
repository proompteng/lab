import { createFileRoute } from '@tanstack/react-router'

import {
  buildAgentsDependencyHealth,
  fetchAgentsHealthFromAgentsService,
} from '@proompteng/agent-contracts/agents-health-client'
import { resolveRuntimeServiceName } from '~/server/runtime-identity'

export const getHealthHandler = async () => {
  const agentsHealth = await fetchAgentsHealthFromAgentsService()
  const agentsDependency = buildAgentsDependencyHealth(agentsHealth)
  const agentsController = agentsDependency.controller
  const body = JSON.stringify({
    status: 'ok',
    service: resolveRuntimeServiceName(),
    agents_dependency: agentsDependency,
    agentsService: agentsHealth.ok
      ? agentsHealth.body
      : {
          status: 'unavailable',
          error: agentsHealth.error,
          httpStatus: agentsHealth.status,
        },
    agentsController,
  })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      GET: () => getHealthHandler(),
    },
  },
})
