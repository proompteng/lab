import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/fills')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleAutotraderRecordFill } = await import('~/server/autotrader-api')
        return handleAutotraderRecordFill(request)
      },
    },
  },
})
