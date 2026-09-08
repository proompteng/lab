import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/auth/logout')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { logoutResponse } = await import('../server/auth/auth.server')
        return await logoutResponse(request)
      },
    },
  },
})
