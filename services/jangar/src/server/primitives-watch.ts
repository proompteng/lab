import { safeJsonStringify } from '~/server/chat-text'
import { startKubernetesWatch } from '~/server/kubernetes-watch-client'
import { buildKubernetesResourceCollectionPath, getNativeKubeClients } from '~/server/primitives-kube'

export type KubectlWatchEvent = {
  type: string
  object: Record<string, unknown>
}

type KubectlWatchOptions = {
  request: Request
  args: string[]
  onEvent: (event: KubectlWatchEvent) => unknown | null
  heartbeatMs?: number
}

type ParsedWatchArgs = {
  resource: string
  namespace: string
  labelSelector?: string
  fieldSelector?: string
}

const parseWatchArgs = (args: string[]): ParsedWatchArgs => {
  if (args[0] !== 'get' || !args[1]) {
    throw new Error(`unsupported watch command: ${args.join(' ')}`)
  }

  const resource = args[1]
  let index = 2
  let name: string | null = null
  if (args[index] && !args[index]?.startsWith('-')) {
    name = args[index] ?? null
    index += 1
  }

  let namespace = 'default'
  let labelSelector: string | undefined
  let fieldSelector: string | undefined

  while (index < args.length) {
    const token = args[index]
    const next = args[index + 1]
    if (!token) break

    if (token === '-n' && next) {
      namespace = next
      index += 2
      continue
    }
    if (token === '-l' && next) {
      labelSelector = next
      index += 2
      continue
    }
    if (token === '--field-selector' && next) {
      fieldSelector = next
      index += 2
      continue
    }
    index += 1
  }

  const namedFieldSelector = name ? `metadata.name=${name}` : null
  return {
    resource,
    namespace,
    labelSelector,
    fieldSelector:
      fieldSelector && namedFieldSelector
        ? `${fieldSelector},${namedFieldSelector}`
        : (fieldSelector ?? namedFieldSelector ?? undefined),
  }
}

const buildWatchPath = async (input: ParsedWatchArgs) => {
  return buildKubernetesResourceCollectionPath(input.resource, input.namespace)
}

export const createKubectlWatchStream = ({ request, args, onEvent, heartbeatMs = 5000 }: KubectlWatchOptions) => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const parsed = parseWatchArgs(args)
      const { kubeConfig } = getNativeKubeClients()
      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let abortController: AbortController | null = null

      const safeEnqueue = (value: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(value))
        } catch {
          cleanup('enqueue-failed')
        }
      }

      const comment = (value: string) => {
        safeEnqueue(`: ${value.replaceAll('\n', ' ')}\n\n`)
      }

      const push = (payload: unknown) => {
        safeEnqueue(`data: ${safeJsonStringify(payload)}\n\n`)
      }

      const cleanup = (reason: string) => {
        if (closed) return
        closed = true
        request.signal.removeEventListener('abort', handleAbort)
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
        abortController?.abort()
        comment(`closed: ${reason}`)
        try {
          controller.close()
        } catch {
          // ignore
        }
      }

      const handleAbort = () => cleanup('abort')
      request.signal.addEventListener('abort', handleAbort)

      safeEnqueue('retry: 1000\n\n')
      comment('connected')

      heartbeat = setInterval(() => {
        comment('keep-alive')
      }, heartbeatMs)

      void buildWatchPath(parsed)
        .then((path) =>
          startKubernetesWatch(
            kubeConfig,
            path,
            {
              ...(parsed.labelSelector ? { labelSelector: parsed.labelSelector } : {}),
              ...(parsed.fieldSelector ? { fieldSelector: parsed.fieldSelector } : {}),
              allowWatchBookmarks: true,
            },
            (type, object) => {
              if (!object || typeof object !== 'object' || Array.isArray(object)) return
              const payload = onEvent({ type, object: object as Record<string, unknown> })
              if (payload) push(payload)
            },
            (error) => {
              if (closed) return
              if (error) {
                push({ type: 'ERROR', error: error instanceof Error ? error.message : String(error) })
              }
              cleanup(error ? 'error' : 'closed')
            },
          ),
        )
        .then((controllerHandle) => {
          abortController = controllerHandle
        })
        .catch((error) => {
          if (closed) return
          push({ type: 'ERROR', error: error instanceof Error ? error.message : String(error) })
          cleanup('error')
        })
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  })
}
