import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/items')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleSubmitItem } = await import('~/server/api')
        return handleSubmitItem(request)
      },
    },
  },
})
