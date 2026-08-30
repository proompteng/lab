import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getAgentRunHandler as getAgentRunApiHandler, type RunReadApiDependencies } from '../../../server/v1/run-read'
import { resolveRunReadApiDependencies, runtimeDependencyErrorResponse } from '../../../server/v1/runtime'

export type { RunReadApiDependencies } from '../../../server/v1/run-read'

export const Route = createFileRoute('/v1/agent-runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: AgentsServerRouteArgs) => getAgentRunHandler(params.id, request),
    },
  },
})

export const getAgentRunHandler = async (id: string, request: Request, deps: Partial<RunReadApiDependencies> = {}) => {
  const resolved = await resolveRunReadApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getAgentRunApiHandler(id, request, resolved.value)
}
