import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getCodexIssuesHandler } from '../../../server/v1/codex-runs'

export const Route = createFileRoute('/v1/codex/issues')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexIssuesHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
