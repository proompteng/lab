import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getFixedKindResource } from '../resource-route-helpers'

export const Route = createFileRoute('/v1/memories/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getMemoryResource(request),
    },
  },
})

export const getMemoryResource = (request: Request, deps: Parameters<typeof getFixedKindResource>[2] = {}) =>
  getFixedKindResource('Memory', request, deps)
