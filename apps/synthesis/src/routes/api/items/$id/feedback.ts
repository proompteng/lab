import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/items/$id/feedback')({
  server: {
    handlers: {
      POST: async ({ request, params }: { request: Request; params: { id: string } }) => {
        const { handleRecordFeedback } = await import('~/server/api')
        return handleRecordFeedback(request, params.id)
      },
    },
  },
})
