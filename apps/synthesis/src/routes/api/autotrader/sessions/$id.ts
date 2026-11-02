import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/sessions/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const { handleAutotraderGetSession } = await import('~/server/autotrader-api')
        return handleAutotraderGetSession(request, params.id)
      },
    },
  },
})
