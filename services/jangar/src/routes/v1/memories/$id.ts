import { createFileRoute } from '@tanstack/react-router'
import {
  getMemoryHandler as getMemoryServiceHandler,
  type MemoryReadDependencies,
} from '@proompteng/agents/routes/v1/memories/$id'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/memories/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getMemoryHandler(params.id, request),
    },
  },
})

type JangarMemoryReadDependencies = Partial<MemoryReadDependencies>

export const getMemoryHandler = async (id: string, request: Request, deps: JangarMemoryReadDependencies = {}) =>
  getMemoryServiceHandler(id, request, deps)
