import { createFileRoute } from '@tanstack/react-router'
import {
  postAgentsHandler as postAgentsServiceHandler,
  type AgentsApiDependencies,
} from '@proompteng/agents/routes/v1/agents'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/agents')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postAgentsHandler(request),
    },
  },
})

type JangarAgentsApiDependencies = Partial<AgentsApiDependencies>

export const postAgentsHandler = async (request: Request, deps: JangarAgentsApiDependencies = {}) =>
  postAgentsServiceHandler(request, deps)
