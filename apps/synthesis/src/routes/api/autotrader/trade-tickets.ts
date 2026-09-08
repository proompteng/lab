import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/trade-tickets')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleAutotraderCreateTradeTicket } = await import('~/server/autotrader-api')
        return handleAutotraderCreateTradeTicket(request)
      },
    },
  },
})
