import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import { getCodexRecentRunsHandler } from '../../../../server/v1/codex-runs'

export const Route = createFileRoute('/v1/codex/runs/recent')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexRecentRunsHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
