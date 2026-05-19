import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

export const Route = createFileRoute('/v1/memories/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getMemoryHandler(params.id, request),
    },
  },
})

export const getMemoryHandler = async (id: string, request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, `/v1/memories/${encodeURIComponent(id)}`)
