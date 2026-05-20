import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { listFixedKindResources } from '../resource-route-helpers'

export const Route = createFileRoute('/v1/swarms/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listSwarmResources(request),
    },
  },
})

export const listSwarmResources = (request: Request, deps: Parameters<typeof listFixedKindResources>[2] = {}) =>
  listFixedKindResources('Swarm', request, deps)
