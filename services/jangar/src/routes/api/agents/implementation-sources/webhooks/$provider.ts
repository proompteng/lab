import { createFileRoute } from '@tanstack/react-router'

import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/implementation-sources/webhooks'

export const Route = createFileRoute('/api/agents/implementation-sources/webhooks/$provider')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ params, request }: JangarServerRouteArgs) =>
        proxyAgentsServiceRequest(request, `${AGENTS_SERVICE_PATH}/${params.provider}`),
    },
  },
})
