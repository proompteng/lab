import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import {
  getCodexRunsPageHandler as getCodexRunsPageApiHandler,
  type CodexRunsApiDependencies,
} from '../../../../server/v1/codex-runs'
import { resolveCodexRunsApiDependencies, runtimeDependencyErrorResponse } from '../../../../server/v1/runtime'

export const Route = createFileRoute('/v1/codex/runs/list')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexRunsPageHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

export const getCodexRunsPageHandler = async (request: Request, deps: Partial<CodexRunsApiDependencies> = {}) => {
  const resolved = await resolveCodexRunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getCodexRunsPageApiHandler(request, resolved.value)
}
