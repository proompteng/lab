import { createFileRoute } from '@tanstack/react-router'

import { refreshPullFilesHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/refresh-files')({
  server: {
    handlers: {
      POST: async ({ request, params }) => refreshPullFilesHandler(request, params),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
