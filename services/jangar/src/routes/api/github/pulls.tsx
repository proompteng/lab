import { createFileRoute } from '@tanstack/react-router'

import { getPullsHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls')({
  server: {
    handlers: {
      GET: async ({ request }) => getPullsHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
