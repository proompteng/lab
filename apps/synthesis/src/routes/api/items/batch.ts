import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/items/batch')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleSubmitBatch } = await import('~/server/api')
        return handleSubmitBatch(request)
      },
    },
  },
})
