import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/orders')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleAutotraderRecordOrder } = await import('~/server/autotrader-api')
        return handleAutotraderRecordOrder(request)
      },
    },
  },
})
