import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import { getAgentEvents } from '../../server/v1/agent-events'

export const Route = createFileRoute('/v1/agent-events')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getAgentEvents(request),
    },
  },
})
