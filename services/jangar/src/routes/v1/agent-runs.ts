import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/v1/agent-runs'

export const Route = createFileRoute('/v1/agent-runs')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getAgentRunsHandler(request),
      POST: async ({ request }: JangarServerRouteArgs) => postAgentRunsHandler(request),
    },
  },
})

export const getAgentRunsHandler = async (request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)

export const postAgentRunsHandler = async (request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
