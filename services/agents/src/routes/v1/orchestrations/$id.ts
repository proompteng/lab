import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import {
  getOrchestrationHandler as getOrchestrationApiHandler,
  type ResourceReadDependencies,
} from '../../../server/v1/resource-read'
import { resolveResourceReadDependencies, runtimeDependencyErrorResponse } from '../../../server/v1/runtime'

export type { ResourceReadDependencies } from '../../../server/v1/resource-read'

export const Route = createFileRoute('/v1/orchestrations/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: AgentsServerRouteArgs) => getOrchestrationHandler(params.id, request),
    },
  },
})

export const getOrchestrationHandler = async (
  id: string,
  request: Request,
  deps: Partial<ResourceReadDependencies> = {},
) => {
  const resolved = await resolveResourceReadDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getOrchestrationApiHandler(id, request, resolved.value)
}
