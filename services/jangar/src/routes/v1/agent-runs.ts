import { createFileRoute } from '@tanstack/react-router'

import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/v1/agent-runs'

export const Route = createFileRoute('/v1/agent-runs')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => proxyV1AgentRuns(request),
      POST: async ({ request }: JangarServerRouteArgs) => proxyV1AgentRuns(request),
    },
  },
})

export const proxyV1AgentRuns = (request: Request) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
