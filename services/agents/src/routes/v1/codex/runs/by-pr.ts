import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import { getCodexRunsByPrHandler } from '../../../../server/v1/codex-runs'

export const Route = createFileRoute('/v1/codex/runs/by-pr')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexRunsByPrHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
