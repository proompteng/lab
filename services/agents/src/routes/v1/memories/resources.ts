import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getTypedResourceHandler } from '../../../server/v1/typed-resources'

export const Route = createFileRoute('/v1/memories/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getMemoryResource(request),
    },
  },
})

export const getMemoryResource = (request: Request, deps: Parameters<typeof getTypedResourceHandler>[2] = {}) =>
  getTypedResourceHandler('Memory', request, deps)
