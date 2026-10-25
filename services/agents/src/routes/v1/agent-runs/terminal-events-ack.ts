import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { ackAgentRunTerminalEvent } from '../../../server/v1/agent-run-terminal-events'

export const Route = createFileRoute('/v1/agent-runs/terminal-events/ack')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => ackAgentRunTerminalEvent(request),
    },
  },
})
