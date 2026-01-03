import { createFileRoute } from '@tanstack/react-router'

import { getPullFilesHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/files')({
  server: {
    handlers: {
      GET: async ({ request, params }) => getPullFilesHandler(request, params),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
