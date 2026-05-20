import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getFixedKindResource } from '../resource-route-helpers'

export const Route = createFileRoute('/v1/secret-bindings/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getSecretBindingResource(request),
    },
  },
})

export const getSecretBindingResource = (request: Request, deps: Parameters<typeof getFixedKindResource>[2] = {}) =>
  getFixedKindResource('SecretBinding', request, deps)
