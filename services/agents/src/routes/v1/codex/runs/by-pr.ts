import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import {
  getCodexRunsByPrHandler as getCodexRunsByPrApiHandler,
  type CodexRunsApiDependencies,
} from '../../../../server/v1/codex-runs'
import { resolveCodexRunsApiDependencies, runtimeDependencyErrorResponse } from '../../../../server/v1/runtime'

export const Route = createFileRoute('/v1/codex/runs/by-pr')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexRunsByPrHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

export const getCodexRunsByPrHandler = async (request: Request, deps: Partial<CodexRunsApiDependencies> = {}) => {
  const resolved = await resolveCodexRunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getCodexRunsByPrApiHandler(request, resolved.value)
}
