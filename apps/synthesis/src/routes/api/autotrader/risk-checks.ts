import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/autotrader/risk-checks')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleAutotraderRecordRiskCheck } = await import('~/server/autotrader-api')
        return handleAutotraderRecordRiskCheck(request)
      },
    },
  },
})
