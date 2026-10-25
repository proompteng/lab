import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getTypedResourceHandler } from '../../../server/v1/typed-resources'

export const Route = createFileRoute('/v1/secret-bindings/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getSecretBindingResource(request),
    },
  },
})

export const getSecretBindingResource = (request: Request, deps: Parameters<typeof getTypedResourceHandler>[2] = {}) =>
  getTypedResourceHandler('SecretBinding', request, deps)
