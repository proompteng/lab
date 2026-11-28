import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getMemoryNoteHandler } from '../../../server/v1/memory-notes'

export const Route = createFileRoute('/v1/memory-notes/$id')({
  server: {
    handlers: { GET: ({ request, params }: AgentsServerRouteArgs) => getMemoryNoteHandler(request, params.id ?? '') },
  },
})
