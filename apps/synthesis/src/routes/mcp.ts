import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleMcpRequest } = await import('~/server/mcp')
        return handleMcpRequest(request)
      },
    },
  },
})
