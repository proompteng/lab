import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getTypedResourceHandler } from '../../../server/v1/typed-resources'

export const Route = createFileRoute('/v1/orchestration-runs/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getOrchestrationRunResource(request),
    },
  },
})

export const getOrchestrationRunResource = (
  request: Request,
  deps: Parameters<typeof getTypedResourceHandler>[2] = {},
) => getTypedResourceHandler('OrchestrationRun', request, deps)
