import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/v1/orchestration-runs'

export const Route = createFileRoute('/v1/orchestration-runs')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getOrchestrationRunsHandler(request),
      POST: async ({ request }: JangarServerRouteArgs) => postOrchestrationRunsHandler(request),
    },
  },
})

export const getOrchestrationRunsHandler = async (request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)

export const postOrchestrationRunsHandler = async (request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
