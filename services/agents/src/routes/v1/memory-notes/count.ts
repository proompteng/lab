import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import {
  getMemoryNotesCountHandler as getMemoryNotesCountApiHandler,
  type MemoryNotesApiDependencies,
} from '../../../server/v1/memory-notes'

export const Route = createFileRoute('/v1/memory-notes/count')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getMemoryNotesCountHandler(request),
    },
  },
})

export const getMemoryNotesCountHandler = async (request: Request, deps: Partial<MemoryNotesApiDependencies> = {}) =>
  getMemoryNotesCountApiHandler(request, deps)
