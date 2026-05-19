import { createFileRoute } from '@tanstack/react-router'

import { fetchAgentsServiceJson } from '~/server/agents-service-client'
import { resolveRuntimeServiceName } from '~/server/runtime-identity'

type AgentsHealthController = {
  enabled: boolean
  crdsReady: boolean | null
}

type AgentsHealthPayload = {
  status?: string
  service?: string
  agentsController?: AgentsHealthController
}

const unavailableAgentsController = (): AgentsHealthController => ({
  enabled: true,
  crdsReady: false,
})

export const getHealthHandler = async () => {
  const agentsHealth = await fetchAgentsServiceJson<AgentsHealthPayload>('/health')
  const agentsController = agentsHealth.body?.agentsController ?? unavailableAgentsController()
  const ready = agentsHealth.ok && (agentsController.enabled ? agentsController.crdsReady !== false : true)
  const body = JSON.stringify({
    status: ready ? 'ok' : 'degraded',
    service: resolveRuntimeServiceName(),
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
    status: ready ? 200 : 503,
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
