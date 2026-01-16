import { createFileRoute } from '@tanstack/react-router'
import { getAgentsControllerHealth } from '~/server/agents-controller'

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      GET: async () => {
        const agentsController = getAgentsControllerHealth()
        const ready = agentsController.enabled ? agentsController.crdsReady !== false : true
        const body = JSON.stringify({
          status: ready ? 'ok' : 'degraded',
          service: 'jangar' as const,
          agentsController,
        })
        return new Response(body, {
          status: ready ? 200 : 503,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body).toString(),
          },
        })
      },
    },
  },
})
