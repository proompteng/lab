import { createFileRoute } from '@tanstack/react-router'

import { createIssueHandler } from '~/server/github-issue-handlers'

export const Route = createFileRoute('/api/github/issues')({
  server: {
    handlers: {
      POST: async ({ request }) => createIssueHandler(request),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
