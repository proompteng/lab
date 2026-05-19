import { createFileRoute } from '@tanstack/react-router'

import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/control-plane/status'

export const Route = createFileRoute('/api/agents/control-plane/status')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getAgentsControlPlaneStatus(request),
    },
  },
})

export const getAgentsControlPlaneStatus = (request: Request) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
