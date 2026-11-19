import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import { postRepoContextHandler } from '../../server/v1/repo-context'

export const Route = createFileRoute('/v1/context')({
  server: { handlers: { POST: ({ request }: AgentsServerRouteArgs) => postRepoContextHandler(request) } },
})
