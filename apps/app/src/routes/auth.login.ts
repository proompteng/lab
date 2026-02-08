import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/auth/login')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { startLoginResponse } = await import('../server/auth/auth.server')
        return await startLoginResponse(request)
      },
    },
  },
})
