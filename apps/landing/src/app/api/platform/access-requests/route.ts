import { toJson } from '@bufbuild/protobuf'
import { z } from 'zod'
import { accessRequestMutationSchema } from '@/lib/platform/access-requests'
import { isAdminPortal, requireAdminIdentity } from '@/lib/platform/admin'
import { platformSession } from '@/lib/platform/auth'
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
  PlatformAccessRequestDecision,
  ListPlatformAccessRequestsResponseSchema,
  CreatePlatformAccessRequestResponseSchema,
  ReviewPlatformAccessRequestResponseSchema,
  CancelPlatformAccessRequestResponseSchema,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requireSameOriginGet(request)
    const identity = await requireAdminIdentity(request)
    const { workspaceId } = z
      .strictObject({ workspaceId: z.uuid() })
      .parse(Object.fromEntries(new URL(request.url).searchParams))
    const result = await ofzCall(
      PlatformAuthorizationService.method.listPlatformAccessRequests,
      { administrator: platformSession(identity), workspaceId },
      request.signal,
    )
    return Response.json(toJson(ListPlatformAccessRequestsResponseSchema, result), { headers: noStoreHeaders() })
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
    const body = accessRequestMutationSchema.parse(
      await readPlatformJsonBody(request, { subject: identity.subject, maxBytes: 8192 }),
    )
    const session = platformSession(identity)
    if (body.kind === 'review') {
      if (!isAdminPortal()) throw new PlatformRequestError('Not found', 404)
      const result = await ofzCall(
        PlatformAuthorizationService.method.reviewPlatformAccessRequest,
        {
          operationId: body.operationId,
          workspaceId: body.workspaceId,
          requestId: body.requestId,
          reason: body.reason,
          administrator: session,
          decision:
            body.decision === 'approve' ? PlatformAccessRequestDecision.APPROVE : PlatformAccessRequestDecision.DECLINE,
        },
        request.signal,
      )
      return Response.json(toJson(ReviewPlatformAccessRequestResponseSchema, result), { headers: noStoreHeaders() })
    }
    if (isAdminPortal()) throw new PlatformRequestError('Not found', 404)
    if (body.kind === 'create') {
      const result = await ofzCall(
        PlatformAuthorizationService.method.createPlatformAccessRequest,
        {
          operationId: body.operationId,
          requester: session,
          workspaceId: body.workspaceId,
          resource: body.resource,
          actions: body.actions,
          reason: body.reason,
        },
        request.signal,
      )
      return Response.json(toJson(CreatePlatformAccessRequestResponseSchema, result), { headers: noStoreHeaders() })
    }
    const result = await ofzCall(
      PlatformAuthorizationService.method.cancelPlatformAccessRequest,
      { operationId: body.operationId, requester: session, requestId: body.requestId },
      request.signal,
    )
    return Response.json(toJson(CancelPlatformAccessRequestResponseSchema, result), { headers: noStoreHeaders() })
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        { error: 'Check the access request and try again' },
        { status: 400, headers: noStoreHeaders() },
      )
    return platformRouteError(error)
  }
}
