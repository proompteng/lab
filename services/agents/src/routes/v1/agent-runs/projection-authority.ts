import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import {
  getAgentRunProjectionAuthorityHandler as getAgentRunProjectionAuthorityApiHandler,
  type AgentRunProjectionAuthorityDeps,
} from '../../../server/v1/agent-run-projection-authority'
import { resolveAgentRunsApiDependencies, runtimeDependencyErrorResponse } from '../../../server/v1/runtime'

export type { AgentRunProjectionAuthorityDeps } from '../../../server/v1/agent-run-projection-authority'

export const Route = createFileRoute('/v1/agent-runs/projection-authority')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getAgentRunProjectionAuthorityHandler(request),
    },
  },
})

export const getAgentRunProjectionAuthorityHandler = async (
  request: Request,
  deps: Partial<AgentRunProjectionAuthorityDeps> = {},
) => {
  const resolved = await resolveAgentRunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getAgentRunProjectionAuthorityApiHandler(request, {
    storeFactory: resolved.value.storeFactory,
    now: deps.now,
  })
}
