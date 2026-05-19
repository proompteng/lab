import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/control-plane/logs'

export const Route = createFileRoute('/api/control-plane/logs')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH),
    },
  },
})
