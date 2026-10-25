import { toJson } from '@bufbuild/protobuf'
import { z } from 'zod'
import {
  PlatformAuthorizationService,
  GetPlatformConfigurationResponseSchema,
  WritePolicyRelationshipsResponseSchema,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { humanContext } from '@/lib/tengri/authorization'
import {
  noStoreHeaders,
  readTengriJsonBody,
  requireSameOrigin,
  requireSameOriginGet,
  requireTengriIdentity,
  tengriRouteError,
} from '@/lib/tengri/http'
import { ofzCall } from '@/lib/tengri/ofz'
const relationship = z.strictObject({
  resource: z.strictObject({ kind: z.string().min(1).max(128), id: z.string().min(1).max(256) }),
  relation: z.string().min(1).max(128),
  subjectKind: z.enum(['human', 'workload']),
  subjectId: z.string().min(1).max(512),
  enabled: z.boolean(),
})
const write = z.strictObject({
  operationId: z.uuid(),
  expectedPolicyVersion: z.string().regex(/^[0-9]{1,19}$/),
  relationships: z.array(relationship).min(1).max(128),
  reason: z.string().min(3).max(512),
})
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requireSameOriginGet(request)
    await requireTengriIdentity(request)
    const result = await ofzCall(PlatformAuthorizationService.method.getPlatformConfiguration, {}, request.signal)
    return Response.json(toJson(GetPlatformConfigurationResponseSchema, result), { headers: noStoreHeaders() })
  } catch (error) {
    return tengriRouteError(error)
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requireTengriIdentity(request)
    const body = write.parse(await readTengriJsonBody(request, { subject: identity.subject, maxBytes: 65_536 }))
    const context = humanContext(identity)
    const result = await ofzCall(
      PlatformAuthorizationService.method.writePolicyRelationships,
      {
        ...body,
        expectedPolicyVersion: BigInt(body.expectedPolicyVersion),
        administrator: { humanId: identity.session.humanId, sessionId: identity.session.id, origin: context.origin },
      },
      request.signal,
    )
    return Response.json(toJson(WritePolicyRelationshipsResponseSchema, result), { headers: noStoreHeaders() })
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: 'Invalid policy relationship request' }, { status: 400, headers: noStoreHeaders() })
    return tengriRouteError(error)
  }
}
