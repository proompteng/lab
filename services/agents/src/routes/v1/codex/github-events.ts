import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import {
  postCodexGithubEventsHandler as postCodexGithubEventsApiHandler,
  type CodexGithubEventsApiDependencies,
} from '../../../server/v1/codex-github-events'
import { resolveCodexGithubEventsApiDependencies, runtimeDependencyErrorResponse } from '../../../server/v1/runtime'

export const Route = createFileRoute('/v1/codex/github-events')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => postCodexGithubEventsHandler(request),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

export const postCodexGithubEventsHandler = async (
  request: Request,
  deps: Partial<CodexGithubEventsApiDependencies> = {},
) => {
  const resolved = await resolveCodexGithubEventsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postCodexGithubEventsApiHandler(request, resolved.value)
}
