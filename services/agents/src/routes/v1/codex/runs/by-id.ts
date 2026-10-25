import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import {
  getCodexRunByIdHandler as getCodexRunByIdApiHandler,
  type CodexRunsApiDependencies,
} from '../../../../server/v1/codex-runs'
import { resolveCodexRunsApiDependencies, runtimeDependencyErrorResponse } from '../../../../server/v1/runtime'

export const Route = createFileRoute('/v1/codex/runs/by-id')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getCodexRunByIdHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

export const getCodexRunByIdHandler = async (request: Request, deps: Partial<CodexRunsApiDependencies> = {}) => {
  const resolved = await resolveCodexRunsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return getCodexRunByIdApiHandler(request, resolved.value)
}
