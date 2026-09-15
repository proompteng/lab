import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getRunHandler as getRunApiHandler, type RunReadApiDependencies } from '../../../server/v1/run-read'
import { resolveRunReadApiDependencies, runtimeDependencyErrorResponse } from '../../../server/v1/runtime'

export type { RunReadApiDependencies } from '../../../server/v1/run-read'

export const Route = createFileRoute('/v1/runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: AgentsServerRouteArgs) => getRunHandler(params.id, request),
    },
  },
})

export const getRunHandler = async (id: string, request: Request, deps: Partial<RunReadApiDependencies> = {}) => {
  const resolved = await resolveRunReadApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getRunApiHandler(id, request, resolved.value)
}
