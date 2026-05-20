import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import { getCodexRunByIdHandler } from '../../../../server/v1/codex-runs'

export const Route = createFileRoute('/v1/codex/runs/by-id')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexRunByIdHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
