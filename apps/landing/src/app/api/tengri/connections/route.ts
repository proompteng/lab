import { toJson } from '@bufbuild/protobuf'
import { z } from 'zod'
import { connectionRequestSchema, disconnectRequestSchema } from '@/lib/tengri/connections'
import {
  disconnectConnection,
  listConnections,
  reconcileConnections,
  saveConnection,
} from '@/lib/tengri/connection-lifecycle'
import { ListPlatformConnectionsResponseSchema } from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import {
  noStoreHeaders,
  readTengriJsonBody,
  requireSameOrigin,
  requireSameOriginGet,
  requireTengriIdentity,
  tengriRouteError,
} from '@/lib/tengri/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    requireSameOriginGet(request)
    const identity = await requireTengriIdentity(request)
    const agentId = z.string().min(1).max(128).parse(new URL(request.url).searchParams.get('agentId'))
    const result = await listConnections(identity, agentId, request.signal)
    return Response.json(toJson(ListPlatformConnectionsResponseSchema, result), { headers: noStoreHeaders() })
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requireTengriIdentity(request)
    const body = connectionRequestSchema.parse(
      await readTengriJsonBody(request, { subject: identity.subject, maxBytes: 32_768 }),
    )
    const result =
      body.kind === 'save'
        ? await saveConnection(identity, body, request.signal)
        : await reconcileConnections(identity, body.agentId, request.signal)
    return Response.json(toJson(ListPlatformConnectionsResponseSchema, result), { headers: noStoreHeaders() })
  } catch (error) {
    return failure(error)
  }
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requireTengriIdentity(request)
    const body = disconnectRequestSchema.parse(
      await readTengriJsonBody(request, { subject: identity.subject, maxBytes: 2048 }),
    )
    return Response.json(await disconnectConnection(identity, body, request.signal), { headers: noStoreHeaders() })
  } catch (error) {
    return failure(error)
  }
}

function failure(error: unknown) {
  return error instanceof z.ZodError
    ? Response.json({ error: 'Invalid connection request' }, { status: 400, headers: noStoreHeaders() })
    : tengriRouteError(error)
}
