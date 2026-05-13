import { createFileRoute } from '@tanstack/react-router'
import { buildSnapshot } from '~/server/gateway'
import { loadGatewayState, persistenceEnabled } from '~/server/persistence'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const snapshot = buildSnapshot(await loadGatewayState())
        return jsonResponse({
          ok: true,
          service: 'secure-action-gateway',
          persistence: persistenceEnabled() ? 'postgres' : 'memory',
          totalTasks: snapshot.stats.totalTasks,
          totalEvents: snapshot.stats.totalEvents,
          awaitingApproval: snapshot.stats.awaitingApproval,
          blockedAgentRuns: snapshot.stats.blockedAgentRuns,
        })
      },
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
