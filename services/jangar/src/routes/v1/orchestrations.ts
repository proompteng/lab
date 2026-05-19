import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/v1/orchestrations'

export const Route = createFileRoute('/v1/orchestrations')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postOrchestrationsHandler(request),
    },
  },
})

export const postOrchestrationsHandler = async (request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
