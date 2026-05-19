import { createFileRoute } from '@tanstack/react-router'

import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/control-plane/resource'

export const Route = createFileRoute('/api/agents/control-plane/resource')({
  server: {
    handlers: {
      DELETE: async ({ request }: JangarServerRouteArgs) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH),
      GET: async ({ request }: JangarServerRouteArgs) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH),
      PATCH: async ({ request }: JangarServerRouteArgs) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH),
      POST: async ({ request }: JangarServerRouteArgs) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH),
    },
  },
})
