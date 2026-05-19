import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import {
  codexCallbackMethodNotAllowedHandler,
  codexCallbackOptionsHandler,
  postCodexCallbackHandler,
} from '../../../../server/codex-callbacks'

export const Route = createFileRoute('/api/agents/codex/notify')({
  server: {
    handlers: {
      POST: async ({ request }: AgentsServerRouteArgs) => postCodexCallbackHandler('notify', request),
      GET: codexCallbackMethodNotAllowedHandler,
      OPTIONS: codexCallbackOptionsHandler,
    },
  },
})
