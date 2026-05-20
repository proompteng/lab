import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { postCodexGithubEventsHandler } from '../../../server/v1/codex-github-events'

export const Route = createFileRoute('/v1/codex/github-events')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => postCodexGithubEventsHandler(request),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})
