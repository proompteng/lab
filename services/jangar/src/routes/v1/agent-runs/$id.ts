import { createFileRoute } from '@tanstack/react-router'
import {
  getAgentRunHandler as getAgentsServiceAgentRunHandler,
  type RunReadApiDependencies,
} from '@proompteng/agents/routes/v1/agent-runs/$id'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/agent-runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getAgentRunHandler(params.id, request),
    },
  },
})

type JangarRunReadApiDependencies = Partial<RunReadApiDependencies>

export const getAgentRunHandler = async (id: string, request: Request, deps: JangarRunReadApiDependencies = {}) =>
  getAgentsServiceAgentRunHandler(id, request, deps)
