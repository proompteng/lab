import { createFileRoute } from '@tanstack/react-router'

import { delegateAgentsRuntimeRequest } from '../server/start-runtime'

const delegate = ({ request }: { request: Request }) => delegateAgentsRuntimeRequest(request)

export const Route = createFileRoute('/v1')({
  server: {
    handlers: {
      DELETE: delegate,
      GET: delegate,
      OPTIONS: delegate,
      PATCH: delegate,
      POST: delegate,
      PUT: delegate,
    },
  },
})
