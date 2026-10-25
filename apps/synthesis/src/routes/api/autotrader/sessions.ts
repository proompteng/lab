import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/sessions')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { handleAutotraderListSessions } = await import('~/server/autotrader-api')
        return handleAutotraderListSessions(request)
      },
      POST: async ({ request }: { request: Request }) => {
        const { handleAutotraderStartSession } = await import('~/server/autotrader-api')
        return handleAutotraderStartSession(request)
      },
    },
  },
})
