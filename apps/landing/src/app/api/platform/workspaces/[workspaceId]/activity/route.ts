import { toJson } from '@bufbuild/protobuf'
import { z } from 'zod'
import { requireAdminIdentity } from '@/lib/platform/admin'
import { platformSession } from '@/lib/platform/auth'
import { noStoreHeaders, requireSameOriginGet, platformRouteError } from '@/lib/platform/http'
import { ofzCall } from '@/lib/platform/ofz'
import {
  PlatformAuthorizationService,
  ReadWorkspaceActivityResponseSchema,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
export const dynamic = 'force-dynamic'
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    requireSameOriginGet(request)
    const identity = await requireAdminIdentity(request)
    const workspaceId = z.uuid().parse((await context.params).workspaceId)
    const filters = z
      .strictObject({
        cursor: z
          .string()
          .regex(/^[0-9]{1,19}$/)
          .optional(),
        action: z
          .string()
          .max(128)
          .regex(/^[^\p{Cc}]*$/u)
          .optional(),
        outcome: z.enum(['allowed', 'denied']).optional(),
        actorId: z
          .string()
          .max(512)
          .regex(/^[^\p{Cc}]*$/u)
          .optional(),
      })
      .parse(Object.fromEntries(new URL(request.url).searchParams))
    const result = await ofzCall(
      PlatformAuthorizationService.method.readWorkspaceActivity,
      { administrator: platformSession(identity), workspaceId, ...filters },
      request.signal,
    )
    return Response.json(toJson(ReadWorkspaceActivityResponseSchema, result), { headers: noStoreHeaders() })
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: 'Invalid activity request' }, { status: 400, headers: noStoreHeaders() })
    return platformRouteError(error)
  }
}
