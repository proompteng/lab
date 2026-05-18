import { createFileRoute } from '@tanstack/react-router'
import {
  getAgentRunsHandler as getAgentsServiceAgentRunsHandler,
  postAgentRunsHandler as postAgentsServiceAgentRunsHandler,
  type AgentRunsApiDependencies,
} from '@proompteng/agents/routes/v1/agent-runs'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/agent-runs')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getAgentRunsHandler(request),
      POST: async ({ request }: JangarServerRouteArgs) => postAgentRunsHandler(request),
    },
  },
})

type JangarAgentRunsApiDependencies = Partial<AgentRunsApiDependencies>

export const getAgentRunsHandler = async (request: Request, deps: JangarAgentRunsApiDependencies = {}) =>
  getAgentsServiceAgentRunsHandler(request, deps)

export const postAgentRunsHandler = async (request: Request, deps: JangarAgentRunsApiDependencies = {}) =>
  postAgentsServiceAgentRunsHandler(request, deps)
