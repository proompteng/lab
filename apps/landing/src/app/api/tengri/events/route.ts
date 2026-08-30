import { normalizeCodexEvent, watchCodexEvents } from '@/lib/tengri/grpc'
import { noStoreHeaders, requireSameOriginGet, requireTengriIdentity, tengriRouteError } from '@/lib/tengri/http'
import { acquireTengriEventStreamSlot, createTengriEventStream, tengriEventStreamHeaders } from '@/lib/tengri/sse'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    requireSameOriginGet(request)
    const identity = await requireTengriIdentity(request)
    const url = new URL(request.url)
    const agentId = url.searchParams.get('agentId') || ''
    const cursor = request.headers.get('last-event-id') || url.searchParams.get('after') || '0'
    const after = Number(cursor)
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(agentId) || !Number.isSafeInteger(after) || after < 0) {
      return Response.json({ error: 'Invalid event stream request' }, { status: 400, headers: noStoreHeaders() })
    }
    const release = acquireTengriEventStreamSlot(identity.subject)
    if (!release) {
      return Response.json({ error: 'Too many active event streams' }, { status: 429, headers: noStoreHeaders() })
    }
    let body: ReadableStream<Uint8Array>
    try {
      const source = watchCodexEvents(identity.subject, agentId, after)
      body = createTengriEventStream(
        source,
        request.signal,
        (value) => {
          const event = normalizeCodexEvent(value)
          return { id: event.sequence, data: event }
        },
        release,
      )
    } catch (error) {
      release()
      throw error
    }
    return new Response(body, {
      headers: { ...noStoreHeaders(), ...tengriEventStreamHeaders() },
    })
  } catch (error) {
    return tengriRouteError(error)
  }
}
