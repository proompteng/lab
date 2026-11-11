import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { postRetireMemoryNoteHandler } from '../../../server/v1/memory-notes'

export const Route = createFileRoute('/v1/memory-notes/retire')({
  server: { handlers: { POST: ({ request }: AgentsServerRouteArgs) => postRetireMemoryNoteHandler(request) } },
})
