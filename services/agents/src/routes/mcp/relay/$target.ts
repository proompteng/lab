import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { handleRelayMcpRequest } from '../../../server/relay/server'

export const Route = createFileRoute('/mcp/relay/$target')({
  server: {
    handlers: {
      POST: ({ request, params }: AgentsServerRouteArgs) => handleRelayMcpRequest(request, params.target),
    },
  },
})
