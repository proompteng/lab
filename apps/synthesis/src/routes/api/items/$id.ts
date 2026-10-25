import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/items/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }: { request: Request; params: { id: string } }) => {
        const { handleGetItem } = await import('~/server/api')
        return handleGetItem(request, params.id)
      },
    },
  },
})
