import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'

import { listFixedKindResources, patchFixedKindResourceMetadata } from '../resource-route-helpers'

export const Route = createFileRoute('/v1/agent-runs/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listAgentRunResources(request),
      PATCH: async ({ request }: AgentsServerRouteArgs) => patchAgentRunResourceAnnotations(request),
    },
  },
})

export const listAgentRunResources = (request: Request, deps: Parameters<typeof listFixedKindResources>[2] = {}) =>
  listFixedKindResources('AgentRun', request, deps)

export const patchAgentRunResourceAnnotations = async (
  request: Request,
  deps: Parameters<typeof patchFixedKindResourceMetadata>[2] = {},
) => patchFixedKindResourceMetadata('AgentRun', request, deps)
