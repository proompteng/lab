import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/assets/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }: { request: Request; params: { id: string } }) => {
        const { handleGetAsset } = await import('~/server/api')
        return handleGetAsset(request, params.id)
      },
    },
  },
})
