import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import { postMemoriesHandler as postMemoriesApiHandler, type MemoriesApiDependencies } from '../../server/v1/memories'
import { resolveMemoriesApiDependencies, runtimeDependencyErrorResponse } from '../../server/v1/runtime'

export type { MemoriesApiDependencies } from '../../server/v1/memories'

export const Route = createFileRoute('/v1/memories')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => postMemoriesHandler(request),
    },
  },
})

export const postMemoriesHandler = async (request: Request, deps: Partial<MemoriesApiDependencies> = {}) => {
  const resolved = await resolveMemoriesApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postMemoriesApiHandler(request, resolved.value)
}
