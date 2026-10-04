import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import {
  postMemoryQueriesHandler as postMemoryQueriesApiHandler,
  type MemoryQueriesApiDependencies,
} from '../../server/v1/memory-queries'
import { resolveMemoryQueriesApiDependencies, runtimeDependencyErrorResponse } from '../../server/v1/runtime'

export type { MemoryQueriesApiDependencies } from '../../server/v1/memory-queries'

export const Route = createFileRoute('/v1/memory-queries')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => postMemoryQueriesHandler(request),
    },
  },
})

export const postMemoryQueriesHandler = async (request: Request, deps: Partial<MemoryQueriesApiDependencies> = {}) => {
  const resolved = await resolveMemoryQueriesApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postMemoryQueriesApiHandler(request, resolved.value)
}
