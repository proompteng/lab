import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/status')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleAutotraderUpsertStatus } = await import('~/server/autotrader-api')
        return handleAutotraderUpsertStatus(request)
      },
    },
  },
})
