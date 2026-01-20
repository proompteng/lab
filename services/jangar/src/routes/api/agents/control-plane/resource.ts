import { createFileRoute } from '@tanstack/react-router'
import { resolvePrimitiveKind } from '~/server/primitives-control-plane'
import { asRecord, asString, errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { createKubernetesClient } from '~/server/primitives-kube'
import { createKubectlWatchStream } from '~/server/primitives-watch'

export const Route = createFileRoute('/api/agents/control-plane/resource')({
  server: {
    handlers: {
      GET: async ({ request }) => getPrimitiveResource(request),
    },
  },
})

export const getPrimitiveResource = async (
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const url = new URL(request.url)
  const kindParam = url.searchParams.get('kind')
  const name = asString(url.searchParams.get('name'))
  const resolved = resolvePrimitiveKind(kindParam)
  if (!resolved) {
    return errorResponse('kind is required', 400)
  }
  if (!name) {
    return errorResponse('name is required', 400)
  }

  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const kube = deps.kubeClient ?? createKubernetesClient()
  const stream = url.searchParams.get('stream') === 'true' || url.searchParams.get('stream') === '1'

  try {
    if (stream) {
      const args = ['get', resolved.resource, name, '-n', namespace, '-o', 'json', '--watch', '--output-watch-events']
      return createKubectlWatchStream({
        request,
        args,
        onEvent: (event) => {
          const summary = {
            apiVersion: asString(event.object.apiVersion) ?? null,
            kind: asString(event.object.kind) ?? null,
            metadata: asRecord(event.object.metadata) ?? {},
            spec: asRecord(event.object.spec) ?? {},
            status: asRecord(event.object.status) ?? {},
          }
          const metadata = asRecord(summary.metadata) ?? {}
          return {
            type: event.type,
            kind: resolved.kind,
            namespace,
            name: asString(metadata.name),
            resource: summary,
          }
        },
      })
    }
    const resource = await kube.get(resolved.resource, name, namespace)
    if (!resource) {
      return errorResponse(`${resolved.kind} not found`, 404, { name, namespace })
    }
    return okResponse({ ok: true, kind: resolved.kind, namespace, resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { kind: resolved.kind, namespace, name })
  }
}
