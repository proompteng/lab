import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import {
  postAgentRunCallbacksHandler as postAgentRunCallbacksApiHandler,
  type AgentRunCallbacksApiDependencies,
} from '../../../../server/v1/agent-run-callbacks'
import { resolveAgentRunCallbacksApiDependencies, runtimeDependencyErrorResponse } from '../../../../server/v1/runtime'

export type { AgentRunCallbacksApiDependencies } from '../../../../server/v1/agent-run-callbacks'

export const Route = createFileRoute('/v1/agent-runs/$id/callbacks')({
  server: {
    handlers: {
      POST: async ({ params, request }: AgentsServerRouteArgs) => postAgentRunCallbacksHandler(params.id, request),
    },
  },
})

export const postAgentRunCallbacksHandler = async (
  id: string,
  request: Request,
  deps: Partial<AgentRunCallbacksApiDependencies> = {},
) => {
  const resolved = await resolveAgentRunCallbacksApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postAgentRunCallbacksApiHandler(id, request, resolved.value)
}
