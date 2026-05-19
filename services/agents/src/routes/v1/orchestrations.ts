import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import {
  postOrchestrationsHandler as postOrchestrationsApiHandler,
  type OrchestrationsApiDependencies,
} from '../../server/v1/orchestrations'
import { resolveOrchestrationsApiDependencies, runtimeDependencyErrorResponse } from '../../server/v1/runtime'

export type { OrchestrationsApiDependencies } from '../../server/v1/orchestrations'

export const Route = createFileRoute('/v1/orchestrations')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => postOrchestrationsHandler(request),
    },
  },
})

export const postOrchestrationsHandler = async (
  request: Request,
  deps: Partial<OrchestrationsApiDependencies> = {},
) => {
  const resolved = await resolveOrchestrationsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postOrchestrationsApiHandler(request, resolved.value)
}
