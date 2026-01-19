import { createFileRoute } from '@tanstack/react-router'

import { postImplementationSourceWebhookHandler } from '~/server/implementation-source-webhooks'

export const Route = createFileRoute('/api/agents/implementation-sources/webhooks/$provider')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ params, request }) => postImplementationSourceWebhookHandler(params.provider, request),
    },
  },
})
