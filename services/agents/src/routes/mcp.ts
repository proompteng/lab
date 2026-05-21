import { createFileRoute, type AgentsServerRouteArgs } from '../server/server-route'
import { handleMcpRequest } from '../server/mcp'

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ request }: AgentsServerRouteArgs) => handleMcpRequest(request),
    },
  },
})
