import { toJson } from '@bufbuild/protobuf'
import { requireAdminIdentity } from '@/lib/platform/admin'
import { platformSession } from '@/lib/platform/auth'
import { noStoreHeaders, requireSameOriginGet, platformRouteError } from '@/lib/platform/http'
import { ofzCall } from '@/lib/platform/ofz'
import {
  PlatformAuthorizationService,
  ListPlatformWorkspacesResponseSchema,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requireSameOriginGet(request)
    const identity = await requireAdminIdentity(request)
    const result = await ofzCall(
      PlatformAuthorizationService.method.listPlatformWorkspaces,
      { administrator: platformSession(identity) },
      request.signal,
    )
    return Response.json(toJson(ListPlatformWorkspacesResponseSchema, result), { headers: noStoreHeaders() })
  } catch (error) {
    return platformRouteError(error)
  }
}
