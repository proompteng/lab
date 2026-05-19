import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

export const Route = createFileRoute('/v1/runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getRunHandler(params.id, request),
    },
  },
})

export const getRunHandler = async (id: string, request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, `/v1/runs/${encodeURIComponent(id)}`)
