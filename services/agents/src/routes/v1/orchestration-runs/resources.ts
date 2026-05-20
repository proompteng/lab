import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getFixedKindResource } from '../resource-route-helpers'

export const Route = createFileRoute('/v1/orchestration-runs/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getOrchestrationRunResource(request),
    },
  },
})

export const getOrchestrationRunResource = (request: Request, deps: Parameters<typeof getFixedKindResource>[2] = {}) =>
  getFixedKindResource('OrchestrationRun', request, deps)
