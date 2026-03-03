import { createFileRoute } from '@tanstack/react-router'

import { getPullWriteActionsHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/write-actions')({
  server: {
    handlers: {
      GET: async ({ request, params }) => getPullWriteActionsHandler(request, params),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
