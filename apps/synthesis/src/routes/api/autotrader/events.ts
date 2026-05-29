import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/events')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleAutotraderAppendEvent } = await import('~/server/autotrader-api')
        return handleAutotraderAppendEvent(request)
      },
    },
  },
})
