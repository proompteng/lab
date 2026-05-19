import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

export const Route = createFileRoute('/v1/agent-runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getAgentRunHandler(params.id, request),
    },
  },
})

export const getAgentRunHandler = async (id: string, request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, `/v1/agent-runs/${encodeURIComponent(id)}`)
