import { createFileRoute } from '@tanstack/react-router'

import { proxyImplementationSourceWebhook } from '~/server/implementation-source-webhooks'

export const Route = createFileRoute('/api/control-plane/implementation-sources/webhooks/$provider')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ params, request }: JangarServerRouteArgs) =>
        proxyImplementationSourceWebhook(request, params.provider),
    },
  },
})
