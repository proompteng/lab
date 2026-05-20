import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getCodexRunHistoryHandler } from '../../../server/v1/codex-runs'

export const Route = createFileRoute('/v1/codex/runs')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexRunHistoryHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
