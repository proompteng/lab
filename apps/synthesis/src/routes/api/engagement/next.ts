import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/engagement/next')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { handleNextEngagement } = await import('~/server/api')
        return handleNextEngagement(request)
      },
    },
  },
})
