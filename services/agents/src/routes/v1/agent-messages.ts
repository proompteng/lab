import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import { postAgentMessagesHandler } from '../../server/v1/agent-messages'

export const Route = createFileRoute('/v1/agent-messages')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => postAgentMessagesHandler(request),
    },
  },
})

export { postAgentMessagesHandler as postV1AgentMessagesHandler }
