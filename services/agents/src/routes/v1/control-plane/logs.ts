import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getAgentRunLogsHandler } from '../../../server/v1/agent-run-logs'

export const Route = createFileRoute('/v1/control-plane/logs')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getAgentRunLogsHandler(request),
    },
  },
})
