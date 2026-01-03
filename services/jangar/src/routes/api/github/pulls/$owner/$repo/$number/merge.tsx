import { createFileRoute } from '@tanstack/react-router'

import { mergePullHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/merge')({
  server: {
    handlers: {
      POST: async ({ request, params }) => mergePullHandler(request, params),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
