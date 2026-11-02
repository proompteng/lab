import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { listAgentRunTerminalEvents } from '../../../server/v1/agent-run-terminal-events'

export const Route = createFileRoute('/v1/agent-runs/terminal-events')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listAgentRunTerminalEvents(request),
    },
  },
})
