import { createFileRoute } from '@tanstack/react-router'

import { getPullChecksHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/checks')({
  server: {
    handlers: {
      GET: async ({ request, params }) => getPullChecksHandler(request, params),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
