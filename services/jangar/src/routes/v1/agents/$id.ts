import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

export const Route = createFileRoute('/v1/agents/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getAgentHandler(params.id, request),
    },
  },
})

export const getAgentHandler = async (id: string, request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, `/v1/agents/${encodeURIComponent(id)}`)
