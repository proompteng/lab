import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import {
  getCodexRunHistoryHandler as getCodexRunHistoryApiHandler,
  type CodexRunsApiDependencies,
} from '../../../server/v1/codex-runs'
import { resolveCodexRunsApiDependencies, runtimeDependencyErrorResponse } from '../../../server/v1/runtime'

export const Route = createFileRoute('/v1/codex/runs')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexRunHistoryHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

export const getCodexRunHistoryHandler = async (request: Request, deps: Partial<CodexRunsApiDependencies> = {}) => {
  const resolved = await resolveCodexRunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getCodexRunHistoryApiHandler(request, resolved.value)
}
