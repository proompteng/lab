import { toJson } from '@bufbuild/protobuf'
import { z } from 'zod'
import { requireAdminIdentity } from '@/lib/platform/admin'
import { platformSession } from '@/lib/platform/auth'
import { noStoreHeaders, requireSameOriginGet, platformRouteError } from '@/lib/platform/http'
import { ofzCall } from '@/lib/platform/ofz'
import {
  PlatformAuthorizationService,
  GetPlatformWorkspaceResponseSchema,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
export const dynamic = 'force-dynamic'
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    requireSameOriginGet(request)
    const identity = await requireAdminIdentity(request)
    const workspaceId = z.uuid().parse((await context.params).workspaceId)
    const result = await ofzCall(
      PlatformAuthorizationService.method.getPlatformWorkspace,
      { administrator: platformSession(identity), workspaceId },
      request.signal,
    )
    return Response.json(toJson(GetPlatformWorkspaceResponseSchema, result), { headers: noStoreHeaders() })
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: 'Invalid workspace' }, { status: 400, headers: noStoreHeaders() })
    return platformRouteError(error)
  }
}
