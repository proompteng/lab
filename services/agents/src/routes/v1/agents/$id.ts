import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getAgentHandler as getAgentApiHandler, type ResourceReadDependencies } from '../../../server/v1/resource-read'
import { resolveResourceReadDependencies, runtimeDependencyErrorResponse } from '../../../server/v1/runtime'

export type { ResourceReadDependencies } from '../../../server/v1/resource-read'

export const Route = createFileRoute('/v1/agents/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: AgentsServerRouteArgs) => getAgentHandler(params.id, request),
    },
  },
})

export const getAgentHandler = async (id: string, request: Request, deps: Partial<ResourceReadDependencies> = {}) => {
  const resolved = await resolveResourceReadDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getAgentApiHandler(id, request, resolved.value)
}
