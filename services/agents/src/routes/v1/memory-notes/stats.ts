import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import {
  getMemoryNotesStatsHandler as getMemoryNotesStatsApiHandler,
  type MemoryNotesApiDependencies,
} from '../../../server/v1/memory-notes'

export const Route = createFileRoute('/v1/memory-notes/stats')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getMemoryNotesStatsHandler(request),
    },
  },
})

export const getMemoryNotesStatsHandler = async (request: Request, deps: Partial<MemoryNotesApiDependencies> = {}) =>
  getMemoryNotesStatsApiHandler(request, deps)
