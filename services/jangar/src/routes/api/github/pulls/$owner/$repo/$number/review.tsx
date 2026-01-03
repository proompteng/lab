import { createFileRoute } from '@tanstack/react-router'

import { submitReviewHandler } from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/review')({
  server: {
    handlers: {
      POST: async ({ request, params }) => submitReviewHandler(request, params),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
