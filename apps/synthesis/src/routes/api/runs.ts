import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/runs')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { handleCreateRun } = await import('~/server/api')
        return handleCreateRun(request)
      },
    },
  },
})
