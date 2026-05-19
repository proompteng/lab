import { createFileRoute } from '@tanstack/react-router'
import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/control-plane/summary'

export const Route = createFileRoute('/api/agents/control-plane/summary')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH),
    },
  },
})
