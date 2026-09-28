import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import {
  postAgentRunRerunsHandler as postAgentRunRerunsApiHandler,
  type AgentRunRerunsApiDependencies,
} from '../../../../server/v1/agent-run-reruns'
import { resolveAgentRunRerunsApiDependencies, runtimeDependencyErrorResponse } from '../../../../server/v1/runtime'

export type { AgentRunRerunsApiDependencies } from '../../../../server/v1/agent-run-reruns'

export const Route = createFileRoute('/v1/agent-runs/$id/reruns')({
  server: {
    handlers: {
      POST: async ({ params, request }: AgentsServerRouteArgs) => postAgentRunRerunsHandler(params.id, request),
    },
  },
})

export const postAgentRunRerunsHandler = async (
  id: string,
  request: Request,
  deps: Partial<AgentRunRerunsApiDependencies> = {},
) => {
  const resolved = await resolveAgentRunRerunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postAgentRunRerunsApiHandler(id, request, resolved.value)
}
