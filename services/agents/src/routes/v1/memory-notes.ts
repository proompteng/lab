import { createFileRoute, type AgentsServerRouteArgs } from '../../server/server-route'
import {
  getMemoryNotesHandler as getMemoryNotesApiHandler,
  postMemoryNotesHandler as postMemoryNotesApiHandler,
  type MemoryNotesApiDependencies,
} from '../../server/v1/memory-notes'

export type { MemoryNotesApiDependencies } from '../../server/v1/memory-notes'

export const Route = createFileRoute('/v1/memory-notes')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getMemoryNotesHandler(request),
      POST: async ({ request }: AgentsServerRouteArgs) => postMemoryNotesHandler(request),
    },
  },
})

export const getMemoryNotesHandler = async (request: Request, deps: Partial<MemoryNotesApiDependencies> = {}) =>
  getMemoryNotesApiHandler(request, deps)

export const postMemoryNotesHandler = async (request: Request, deps: Partial<MemoryNotesApiDependencies> = {}) =>
  postMemoryNotesApiHandler(request, deps)
