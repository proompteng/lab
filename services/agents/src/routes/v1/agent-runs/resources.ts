import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { listTypedResourceHandler, patchTypedResourceMetadataHandler } from '../../../server/v1/typed-resources'

export const Route = createFileRoute('/v1/agent-runs/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listAgentRunResources(request),
      PATCH: async ({ request }: AgentsServerRouteArgs) => patchAgentRunResourceAnnotations(request),
    },
  },
})

export const listAgentRunResources = (request: Request, deps: Parameters<typeof listTypedResourceHandler>[2] = {}) =>
  listTypedResourceHandler('AgentRun', request, deps)

export const patchAgentRunResourceAnnotations = async (
  request: Request,
  deps: Parameters<typeof patchTypedResourceMetadataHandler>[2] = {},
) => patchTypedResourceMetadataHandler('AgentRun', request, deps)
