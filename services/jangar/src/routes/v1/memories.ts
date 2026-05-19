import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/v1/memories'

export const Route = createFileRoute('/v1/memories')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postMemoriesHandler(request),
    },
  },
})

export const postMemoriesHandler = async (request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
