import { createFileRoute } from '@tanstack/react-router'
import { getAgentsControllerHealth } from '@proompteng/agents/server/agents-controller'

import { resolveRuntimeServiceName } from '~/server/runtime-identity'

export const getHealthHandler = () => {
  const agentsController = getAgentsControllerHealth()
  const ready = agentsController.enabled ? agentsController.crdsReady !== false : true
  const body = JSON.stringify({
    status: ready ? 'ok' : 'degraded',
    service: resolveRuntimeServiceName(),
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
      GET: getHealthHandler,
    },
  },
})
