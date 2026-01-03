import { createFileRoute } from '@tanstack/react-router'

import { getPullThreadsHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/threads')({
  server: {
    handlers: {
      GET: async ({ request, params }) => getPullThreadsHandler(request, params),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
