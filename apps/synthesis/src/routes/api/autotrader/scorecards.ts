import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/scorecards')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { handleAutotraderGetScorecard } = await import('~/server/autotrader-api')
        return handleAutotraderGetScorecard(request)
      },
    },
  },
})
