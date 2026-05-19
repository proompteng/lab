import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/v1/memory-queries'

export const Route = createFileRoute('/v1/memory-queries')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postMemoryQueriesHandler(request),
    },
  },
})

export const postMemoryQueriesHandler = async (request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
