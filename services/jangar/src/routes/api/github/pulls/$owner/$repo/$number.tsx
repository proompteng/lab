import { createFileRoute } from '@tanstack/react-router'

import { getPullHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number')({
  server: {
    handlers: {
      GET: async ({ request, params }) => getPullHandler(request, params),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
