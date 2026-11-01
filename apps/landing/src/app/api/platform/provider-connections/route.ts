import { randomBytes } from 'node:crypto'
import { toJson } from '@bufbuild/protobuf'
import { z } from 'zod'
import { cookie, setCookie, platformSession } from '@/lib/platform/auth'
import { providerMutationSchema } from '@/lib/platform/provider-connections'
import {
  noStoreHeaders,
  readPlatformJsonBody,
  requirePlatformIdentity,
  requireSameOrigin,
  requireSameOriginGet,
  platformRouteError,
  PlatformRequestError,
} from '@/lib/platform/http'
import { ofzCall } from '@/lib/platform/ofz'
import {
  PlatformAuthorizationService,
  ListProviderConnectionsResponseSchema,
  BeginProviderConnectionResponseSchema,
  DisconnectProviderConnectionResponseSchema,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requireSameOriginGet(request)
    const identity = await requirePlatformIdentity(request)
    const { workspaceId } = z
      .object({ workspaceId: z.uuid().optional() })
      .parse(Object.fromEntries(new URL(request.url).searchParams))
    const result = await ofzCall(
      PlatformAuthorizationService.method.listProviderConnections,
      { human: platformSession(identity), workspaceId },
      request.signal,
    )
    const headers = noStoreHeaders()
    if (!cookie(request.headers, '__Host-platform-provider'))
      headers['Set-Cookie'] = setCookie('__Host-platform-provider', randomBytes(32).toString('base64url'), 28800)
    return Response.json(toJson(ListProviderConnectionsResponseSchema, result), { headers })
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: 'Choose a workspace' }, { status: 400, headers: noStoreHeaders() })
    return platformRouteError(error)
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requirePlatformIdentity(request)
    const body = providerMutationSchema.parse(
      await readPlatformJsonBody(request, { subject: identity.subject, maxBytes: 8192 }),
    )
    if (body.kind === 'begin') {
      const binding = cookie(request.headers, '__Host-platform-provider')
      if (!binding) throw new PlatformRequestError('Refresh Connections before starting account authorization.', 409)
      const result = await ofzCall(
        PlatformAuthorizationService.method.beginProviderConnection,
        {
          operationId: body.operationId,
          human: platformSession(identity),
          profileId: body.profileId,
          binding,
          returnPath: body.returnPath,
        },
        request.signal,
      )
      return Response.json(toJson(BeginProviderConnectionResponseSchema, result), { headers: noStoreHeaders() })
    }
    const result = await ofzCall(
      PlatformAuthorizationService.method.disconnectProviderConnection,
      {
        operationId: body.operationId,
        human: platformSession(identity),
        profileId: body.profileId,
        connectionId: body.connectionId,
      },
      request.signal,
    )
    return Response.json(toJson(DisconnectProviderConnectionResponseSchema, result), { headers: noStoreHeaders() })
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        { error: 'Check the account change and try again' },
        { status: 400, headers: noStoreHeaders() },
      )
    return platformRouteError(error)
  }
}
