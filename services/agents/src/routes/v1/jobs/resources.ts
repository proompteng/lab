import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { listTypedResourceHandler } from '../../../server/v1/typed-resources'

export const Route = createFileRoute('/v1/jobs/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listJobResources(request),
    },
  },
})

export const listJobResources = (request: Request, deps: Parameters<typeof listTypedResourceHandler>[2] = {}) =>
  listTypedResourceHandler('Job', request, deps)
