import { createFileRoute } from '@tanstack/react-router'

import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/control-plane/status'

export const Route = createFileRoute('/api/control-plane/status')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getControlPlaneStatus(request),
    },
  },
})

export const getControlPlaneStatus = (request: Request) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
