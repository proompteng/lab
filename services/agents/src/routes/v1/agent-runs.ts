import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import {
  getAgentRunsHandler as getAgentRunsApiHandler,
  postAgentRunsHandler as postAgentRunsApiHandler,
  type AgentRunsApiDependencies,
} from '../../server/v1/agent-runs'
import { resolveAgentRunsApiDependencies, runtimeDependencyErrorResponse } from '../../server/v1/runtime'

export type { AgentRunsApiDependencies } from '../../server/v1/agent-runs'

export const Route = createFileRoute('/v1/agent-runs')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getAgentRunsHandler(request),
      POST: async ({ request }: AgentsServerRouteArgs) => postAgentRunsHandler(request),
    },
  },
})

export const getAgentRunsHandler = async (request: Request, deps: Partial<AgentRunsApiDependencies> = {}) => {
  const resolved = await resolveAgentRunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getAgentRunsApiHandler(request, resolved.value)
}

export const postAgentRunsHandler = async (request: Request, deps: Partial<AgentRunsApiDependencies> = {}) => {
  const resolved = await resolveAgentRunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postAgentRunsApiHandler(request, resolved.value)
}
