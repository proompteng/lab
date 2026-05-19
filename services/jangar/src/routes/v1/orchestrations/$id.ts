import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

export const Route = createFileRoute('/v1/orchestrations/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getOrchestrationHandler(params.id, request),
    },
  },
})

export const getOrchestrationHandler = async (id: string, request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, `/v1/orchestrations/${encodeURIComponent(id)}`)
