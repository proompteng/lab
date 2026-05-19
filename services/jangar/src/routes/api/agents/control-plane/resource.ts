import { createFileRoute } from '@tanstack/react-router'

import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/control-plane/resource'

export const Route = createFileRoute('/api/agents/control-plane/resource')({
  server: {
    handlers: {
      DELETE: async ({ request }: JangarServerRouteArgs) => proxyAgentsControlPlaneResource(request),
      GET: async ({ request }: JangarServerRouteArgs) => proxyAgentsControlPlaneResource(request),
      PATCH: async ({ request }: JangarServerRouteArgs) => proxyAgentsControlPlaneResource(request),
      POST: async ({ request }: JangarServerRouteArgs) => proxyAgentsControlPlaneResource(request),
    },
  },
})

export const proxyAgentsControlPlaneResource = (request: Request) =>
  proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
