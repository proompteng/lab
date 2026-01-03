import { createFileRoute } from '@tanstack/react-router'

import { resolveThreadHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/threads/$threadId/resolve')({
  server: {
    handlers: {
      POST: async ({ request, params }) => resolveThreadHandler(request, params),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
