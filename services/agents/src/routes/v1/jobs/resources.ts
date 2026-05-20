import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { listFixedKindResources } from '../resource-route-helpers'

export const Route = createFileRoute('/v1/jobs/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listJobResources(request),
    },
  },
})

export const listJobResources = (request: Request, deps: Parameters<typeof listFixedKindResources>[2] = {}) =>
  listFixedKindResources('Job', request, deps)
