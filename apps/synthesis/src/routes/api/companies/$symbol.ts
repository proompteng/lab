import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/companies/$symbol')({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { symbol: string }; request: Request }) => {
        const { handleGetCompany } = await import('~/server/api')
        return handleGetCompany(request, params.symbol)
      },
      POST: async ({ params, request }: { params: { symbol: string }; request: Request }) => {
        const { handlePrefillCompany } = await import('~/server/api')
        return handlePrefillCompany(request, params.symbol)
      },
    },
  },
})
