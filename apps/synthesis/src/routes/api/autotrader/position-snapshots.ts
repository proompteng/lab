import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/position-snapshots')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleAutotraderRecordPositionSnapshot } = await import('~/server/autotrader-api')
        return handleAutotraderRecordPositionSnapshot(request)
      },
    },
  },
})
