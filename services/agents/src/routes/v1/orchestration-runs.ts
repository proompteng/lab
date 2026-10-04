import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import {
  getOrchestrationRunsHandler as getOrchestrationRunsApiHandler,
  postOrchestrationRunsHandler as postOrchestrationRunsApiHandler,
  type OrchestrationRunsApiDependencies,
} from '../../server/v1/orchestration-runs'
import { resolveOrchestrationRunsApiDependencies, runtimeDependencyErrorResponse } from '../../server/v1/runtime'

export type { OrchestrationRunsApiDependencies } from '../../server/v1/orchestration-runs'

export const Route = createFileRoute('/v1/orchestration-runs')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getOrchestrationRunsHandler(request),
      POST: async ({ request }: AgentsServerRouteArgs) => postOrchestrationRunsHandler(request),
    },
  },
})

export const getOrchestrationRunsHandler = async (
  request: Request,
  deps: Partial<OrchestrationRunsApiDependencies> = {},
) => {
  const resolved = await resolveOrchestrationRunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getOrchestrationRunsApiHandler(request, resolved.value)
}

export const postOrchestrationRunsHandler = async (
  request: Request,
  deps: Partial<OrchestrationRunsApiDependencies> = {},
) => {
  const resolved = await resolveOrchestrationRunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postOrchestrationRunsApiHandler(request, resolved.value)
}
