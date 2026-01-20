import { EventEmitter } from 'node:events'

import { createFileRoute } from '@tanstack/react-router'

import { safeJsonStringify } from '~/server/chat-text'
import { resolveGrpcStatus } from '~/server/control-plane-grpc'
import { buildControlPlaneStatus, type ControlPlaneStatus } from '~/server/control-plane-status'
import { startResourceWatch } from '~/server/kube-watch'
import { recordSseConnection, recordSseError } from '~/server/metrics'
import { type AgentPrimitiveKind, listPrimitiveKinds, resolvePrimitiveKind } from '~/server/primitives-control-plane'
import { asRecord, asString, normalizeNamespace } from '~/server/primitives-http'

export const Route = createFileRoute('/api/agents/control-plane/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => streamControlPlaneEvents(request),
    },
  },
})

type ControlPlaneResourceEvent = {
  type: 'resource'
  kind: AgentPrimitiveKind
  namespace: string
  action: string | null
  name: string | null
  resource: Record<string, unknown>
}

type ControlPlaneStatusEvent = {
  type: 'status'
  namespace: string
  status: ControlPlaneStatus
}

type ControlPlaneErrorEvent = {
  type: 'error'
  namespace: string
  message: string
}

type ControlPlaneStreamEvent = ControlPlaneResourceEvent | ControlPlaneStatusEvent | ControlPlaneErrorEvent

type NamespaceStream = {
  emitter: EventEmitter
  refCount: number
  watchers: Array<{ stop: () => void }>
  statusTimeout: NodeJS.Timeout | null
  lastStatus: ControlPlaneStatus | null
}

const HEARTBEAT_INTERVAL_MS = 15_000
const STATUS_DEBOUNCE_MS = 500

const namespaceStreams = new Map<string, NamespaceStream>()

const toSummary = (resource: Record<string, unknown>) => ({
  apiVersion: asString(resource.apiVersion) ?? null,
  kind: asString(resource.kind) ?? null,
  metadata: asRecord(resource.metadata) ?? {},
  spec: asRecord(resource.spec) ?? {},
  status: asRecord(resource.status) ?? {},
})

const buildStatus = async (namespace: string) =>
  buildControlPlaneStatus({
    namespace,
    grpc: resolveGrpcStatus(),
  })

const emitStatus = async (stream: NamespaceStream, namespace: string) => {
  if (stream.statusTimeout) {
    clearTimeout(stream.statusTimeout)
    stream.statusTimeout = null
  }
  try {
    const status = await buildStatus(namespace)
    stream.lastStatus = status
    stream.emitter.emit('event', { type: 'status', namespace, status } satisfies ControlPlaneStatusEvent)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordSseError('control-plane', 'status')
    stream.emitter.emit('event', { type: 'error', namespace, message } satisfies ControlPlaneErrorEvent)
  }
}

const scheduleStatusRefresh = (stream: NamespaceStream, namespace: string) => {
  if (stream.statusTimeout) return
  stream.statusTimeout = setTimeout(() => {
    void emitStatus(stream, namespace)
  }, STATUS_DEBOUNCE_MS)
}

const ensureNamespaceStream = (namespace: string): NamespaceStream => {
  const existing = namespaceStreams.get(namespace)
  if (existing) {
    existing.refCount += 1
    return existing
  }

  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)

  const stream: NamespaceStream = {
    emitter,
    refCount: 1,
    watchers: [],
    statusTimeout: null,
    lastStatus: null,
  }

  const kinds = listPrimitiveKinds()
  for (const kind of kinds) {
    const resolved = resolvePrimitiveKind(kind)
    if (!resolved) continue

    stream.watchers.push(
      startResourceWatch({
        resource: resolved.resource,
        namespace,
        logPrefix: '[jangar][control-plane-stream]',
        onEvent: (event) => {
          const payload = asRecord(event.object) ?? {}
          const summary = toSummary(payload)
          const metadata = asRecord(summary.metadata) ?? {}
          const resourceNamespace = asString(metadata.namespace) ?? namespace
          const name = asString(metadata.name) ?? null
          stream.emitter.emit('event', {
            type: 'resource',
            kind: resolved.kind,
            namespace: resourceNamespace,
            action: event.type ?? null,
            name,
            resource: summary,
          } satisfies ControlPlaneResourceEvent)
          scheduleStatusRefresh(stream, namespace)
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : String(error)
          recordSseError('control-plane', 'watch')
          stream.emitter.emit('event', { type: 'error', namespace, message } satisfies ControlPlaneErrorEvent)
        },
      }),
    )
  }

  namespaceStreams.set(namespace, stream)
  void emitStatus(stream, namespace)
  return stream
}

const releaseNamespaceStream = (namespace: string) => {
  const stream = namespaceStreams.get(namespace)
  if (!stream) return
  stream.refCount -= 1
  if (stream.refCount > 0) return

  for (const watcher of stream.watchers) {
    watcher.stop()
  }
  stream.watchers = []
  if (stream.statusTimeout) {
    clearTimeout(stream.statusTimeout)
    stream.statusTimeout = null
  }

  namespaceStreams.delete(namespace)
}

const subscribeNamespaceEvents = (namespace: string, onEvent: (event: ControlPlaneStreamEvent) => void) => {
  const stream = ensureNamespaceStream(namespace)
  const listener = (event: ControlPlaneStreamEvent) => onEvent(event)
  stream.emitter.on('event', listener)
  return () => {
    stream.emitter.off('event', listener)
    releaseNamespaceStream(namespace)
  }
}

export const streamControlPlaneEvents = async (request: Request) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const encoder = new TextEncoder()

  let heartbeat: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      recordSseConnection('control-plane', 'opened')

      const safeEnqueue = (value: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(value))
        } catch (_error) {
          recordSseError('control-plane', 'enqueue')
          if (!closed) {
            closed = true
            try {
              controller.close()
            } catch {
              // ignore
            }
          }
        }
      }

      const push = (payload: unknown) => {
        safeEnqueue(`data: ${safeJsonStringify(payload)}\n\n`)
      }

      safeEnqueue('retry: 1000\n\n')
      safeEnqueue(': connected\n\n')

      unsubscribe = subscribeNamespaceEvents(namespace, (event) => {
        push(event)
      })

      const streamState = namespaceStreams.get(namespace)
      if (streamState?.lastStatus) {
        push({ type: 'status', namespace, status: streamState.lastStatus })
      }

      heartbeat = setInterval(() => {
        safeEnqueue(': keep-alive\n\n')
      }, HEARTBEAT_INTERVAL_MS)
    },
    cancel() {
      closed = true
      recordSseConnection('control-plane', 'closed')
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      if (unsubscribe) unsubscribe()
      unsubscribe = null
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
