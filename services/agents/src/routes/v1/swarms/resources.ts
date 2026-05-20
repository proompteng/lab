import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { listTypedResourceHandler } from '../../../server/v1/typed-resources'

export const Route = createFileRoute('/v1/swarms/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listSwarmResources(request),
    },
  },
})

export const listSwarmResources = (request: Request, deps: Parameters<typeof listTypedResourceHandler>[2] = {}) =>
  listTypedResourceHandler('Swarm', request, deps)
