import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getMemoryHandler as getMemoryApiHandler, type MemoryReadDependencies } from '../../../server/v1/resource-read'
import { resolveMemoryReadDependencies, runtimeDependencyErrorResponse } from '../../../server/v1/runtime'

export type { MemoryReadDependencies } from '../../../server/v1/resource-read'

export const Route = createFileRoute('/v1/memories/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: AgentsServerRouteArgs) => getMemoryHandler(params.id, request),
    },
  },
})

export const getMemoryHandler = async (id: string, request: Request, deps: Partial<MemoryReadDependencies> = {}) => {
  const resolved = await resolveMemoryReadDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getMemoryApiHandler(id, request, resolved.value)
}
