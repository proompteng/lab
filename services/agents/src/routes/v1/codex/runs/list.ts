import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import { getCodexRunsPageHandler } from '../../../../server/v1/codex-runs'

export const Route = createFileRoute('/v1/codex/runs/list')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexRunsPageHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
