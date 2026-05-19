import { createFileRoute } from '@tanstack/react-router'

import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/control-plane/stream'

export const Route = createFileRoute('/api/control-plane/stream')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => streamControlPlaneEvents(request),
    },
  },
})

export const streamControlPlaneEvents = async (request: Request, _deps: unknown = {}) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
