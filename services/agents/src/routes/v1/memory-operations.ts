import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import {
  postMemoryOperationsHandler as postMemoryOperationsApiHandler,
  type MemoryOperationsApiDependencies,
} from '../../server/v1/memory-operations'
import { resolveMemoryOperationsApiDependencies, runtimeDependencyErrorResponse } from '../../server/v1/runtime'

export type { MemoryOperationsApiDependencies } from '../../server/v1/memory-operations'

export const Route = createFileRoute('/v1/memory-operations')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => postMemoryOperationsHandler(request),
    },
  },
})

export const postMemoryOperationsHandler = async (
  request: Request,
  deps: Partial<MemoryOperationsApiDependencies> = {},
) => {
  const resolved = await resolveMemoryOperationsApiDependencies(deps)
  if (!resolved.ok) return runtimeDependencyErrorResponse(resolved.error)
  return postMemoryOperationsApiHandler(request, resolved.value)
}
