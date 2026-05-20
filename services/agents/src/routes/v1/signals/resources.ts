import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getFixedKindResource, postFixedKindResource } from '../resource-route-helpers'

export const Route = createFileRoute('/v1/signals/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getSignalResource(request),
      POST: async ({ request }: AgentsServerRouteArgs) => postSignalResource(request),
    },
  },
})

export const getSignalResource = (request: Request, deps: Parameters<typeof getFixedKindResource>[2] = {}) =>
  getFixedKindResource('Signal', request, deps)

export const postSignalResource = (request: Request, deps: Parameters<typeof postFixedKindResource>[2] = {}) =>
  postFixedKindResource('Signal', request, deps)
