import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/finalize')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleAutotraderFinalizeSession } = await import('~/server/autotrader-api')
        return handleAutotraderFinalizeSession(request)
      },
    },
  },
})
