import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getTypedResourceHandler, postTypedResourceHandler } from '../../../server/v1/typed-resources'

export const Route = createFileRoute('/v1/signals/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getSignalResource(request),
      POST: async ({ request }: AgentsServerRouteArgs) => postSignalResource(request),
    },
  },
})

export const getSignalResource = (request: Request, deps: Parameters<typeof getTypedResourceHandler>[2] = {}) =>
  getTypedResourceHandler('Signal', request, deps)

export const postSignalResource = (request: Request, deps: Parameters<typeof postTypedResourceHandler>[2] = {}) =>
  postTypedResourceHandler('Signal', request, deps)
