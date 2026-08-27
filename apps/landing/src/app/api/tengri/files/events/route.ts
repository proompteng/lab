import { normalizeFileEvent, watchFiles } from '@/lib/tengri/grpc'
import { noStoreHeaders, requireTengriIdentity, tengriRouteError } from '@/lib/tengri/http'
import { acquireTengriEventStreamSlot, createTengriEventStream, tengriEventStreamHeaders } from '@/lib/tengri/sse'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const identity = await requireTengriIdentity(request)
    const url = new URL(request.url)
    const agentId = url.searchParams.get('agentId') || ''
    const path = url.searchParams.get('path') || '/'
    const cursor = request.headers.get('last-event-id') || url.searchParams.get('after') || '0'
    const after = Number(cursor)
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(agentId) ||
      !path.startsWith('/') ||
      path.includes('\0') ||
      path.length > 4_096 ||
      !Number.isSafeInteger(after) ||
      after < 0
    ) {
      return Response.json({ error: 'Invalid file event stream request' }, { status: 400, headers: noStoreHeaders() })
    }
    const release = acquireTengriEventStreamSlot(identity.subject)
    if (!release) {
      return Response.json({ error: 'Too many active event streams' }, { status: 429, headers: noStoreHeaders() })
    }
    let body: ReadableStream<Uint8Array>
    try {
      const source = watchFiles(identity.subject, agentId, path, after)
      body = createTengriEventStream(
        source,
        request.signal,
        (value) => {
          const event = normalizeFileEvent(value)
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
