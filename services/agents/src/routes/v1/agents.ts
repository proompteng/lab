import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import { postAgentsHandler as postAgentsApiHandler, type AgentsApiDependencies } from '../../server/v1/agents'
import { resolveAgentsApiDependencies, runtimeDependencyErrorResponse } from '../../server/v1/runtime'

export type { AgentsApiDependencies } from '../../server/v1/agents'

export const Route = createFileRoute('/v1/agents')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => postAgentsHandler(request),
    },
  },
})

export const postAgentsHandler = async (request: Request, deps: Partial<AgentsApiDependencies> = {}) => {
  const resolved = await resolveAgentsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postAgentsApiHandler(request, resolved.value)
}
