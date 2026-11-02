import { createFileRoute } from '@tanstack/react-router'

import { buildAgentsDependencyHealth, fetchAgentsHealthFromAgentsService } from '@proompteng/agent-contracts'
import { resolveRuntimeServiceName } from '~/server/runtime-identity'

export const getHealthHandler = async () => {
  const agentsHealth = await fetchAgentsHealthFromAgentsService()
  const agentsDependencyHealth = buildAgentsDependencyHealth(agentsHealth)
  const agentsDependency = {
    status: agentsDependencyHealth.status,
    ready: agentsDependencyHealth.ready,
    http_status: agentsDependencyHealth.http_status,
    error: agentsDependencyHealth.error,
  }
  const body = JSON.stringify({
    status: 'ok',
    service: resolveRuntimeServiceName(),
    agents_dependency: agentsDependency,
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
