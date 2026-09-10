import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/feed')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { handleListFeed } = await import('~/server/api')
        return handleListFeed(request)
      },
    },
  },
})
