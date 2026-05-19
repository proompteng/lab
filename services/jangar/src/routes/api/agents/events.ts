import { createFileRoute } from '@tanstack/react-router'

import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/events'

export const Route = createFileRoute('/api/agents/events')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getAgentsEvents(request),
    },
  },
})

export const getAgentsEvents = (request: Request) => proxyAgentsServiceRequest(request, AGENTS_SERVICE_PATH)
