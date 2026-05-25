import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/engagement/$id/result')({
  server: {
    handlers: {
      POST: async ({ request, params }: { request: Request; params: { id: string } }) => {
        const { handleRecordEngagementResult } = await import('~/server/api')
        return handleRecordEngagementResult(request, params.id)
      },
    },
  },
})
