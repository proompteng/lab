import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import {
  getOrchestrationRunHandler as getOrchestrationRunApiHandler,
  type OrchestrationRunReadDependencies,
} from '../../../server/v1/resource-read'
import { resolveOrchestrationRunReadDependencies, runtimeDependencyErrorResponse } from '../../../server/v1/runtime'

export type { OrchestrationRunReadDependencies } from '../../../server/v1/resource-read'

export const Route = createFileRoute('/v1/orchestration-runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: AgentsServerRouteArgs) => getOrchestrationRunHandler(params.id, request),
    },
  },
})

export const getOrchestrationRunHandler = async (
  id: string,
  request: Request,
  deps: Partial<OrchestrationRunReadDependencies> = {},
) => {
  const resolved = await resolveOrchestrationRunReadDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getOrchestrationRunApiHandler(id, request, resolved.value)
}
