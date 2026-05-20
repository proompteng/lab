import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'

import { patchPrimitiveResourceMetadata } from '../../api/agents/control-plane/resource'
import { listPrimitiveResources } from '../../api/agents/control-plane/resources'

export const Route = createFileRoute('/v1/agent-runs/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listAgentRunResources(request),
      PATCH: async ({ request }: AgentsServerRouteArgs) => patchAgentRunResourceAnnotations(request),
    },
  },
})

const toAgentRunResourcesUrl = (request: Request) => {
  const incoming = new URL(request.url)
  const target = new URL('/api/agents/control-plane/resources', incoming.origin)
  for (const [key, value] of incoming.searchParams) {
    if (key !== 'kind') target.searchParams.append(key, value)
  }
  target.searchParams.set('kind', 'AgentRun')
  return target
}

const toAgentRunResourcePatchUrl = (request: Request) => {
  const incoming = new URL(request.url)
  const target = new URL('/api/agents/control-plane/resource', incoming.origin)
  for (const [key, value] of incoming.searchParams) {
    if (key !== 'kind') target.searchParams.append(key, value)
  }
  target.searchParams.set('kind', 'AgentRun')
  return target
}

export const listAgentRunResources = (request: Request, deps: Parameters<typeof listPrimitiveResources>[1] = {}) =>
  listPrimitiveResources(new Request(toAgentRunResourcesUrl(request), { headers: request.headers }), deps)

export const patchAgentRunResourceAnnotations = async (
  request: Request,
  deps: Parameters<typeof patchPrimitiveResourceMetadata>[1] = {},
) => {
  const body = await request.text()
  return patchPrimitiveResourceMetadata(
    new Request(toAgentRunResourcePatchUrl(request), {
      body,
      headers: request.headers,
      method: 'PATCH',
    }),
    deps,
  )
}
