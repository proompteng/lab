import { createFileRoute } from '@tanstack/react-router'

import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/control-plane/stream'

export const Route = createFileRoute('/api/agents/control-plane/stream')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => streamAgentsControlPlaneEvents(request),
    },
  },
})

export const streamAgentsControlPlaneEvents = (request: Request) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
