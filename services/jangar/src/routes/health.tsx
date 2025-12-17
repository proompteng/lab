import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      GET: async () => {
        const body = JSON.stringify({ status: 'ok', service: 'jangar' as const })
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body).toString(),
          },
        })
      },
    },
  },
})
