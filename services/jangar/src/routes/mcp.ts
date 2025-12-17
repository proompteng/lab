import { createFileRoute } from '@tanstack/react-router'
import { handleMcpRequest } from '~/server/mcp'

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ request }) => handleMcpRequest(request),
    },
  },
})
