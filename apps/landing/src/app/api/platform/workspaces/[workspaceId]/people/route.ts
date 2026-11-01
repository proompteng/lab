import { z } from 'zod'
import { platformSession, requireAdminIdentity } from '@/lib/platform/admin'
import { resolveGithubIdentity } from '@/lib/platform/github-identity'
import { githubLoginSchema } from '@/lib/tengri/access-schemas'
import { noStoreHeaders, readPlatformJsonBody, requireSameOrigin, platformRouteError } from '@/lib/platform/http'
import { ofzCall } from '@/lib/platform/ofz'
import { PlatformAuthorizationService } from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    requireSameOrigin(request)
    const identity = await requireAdminIdentity(request)
    const workspaceId = z.uuid().parse((await context.params).workspaceId)
    const body = z
      .strictObject({ login: githubLoginSchema })
      .parse(await readPlatformJsonBody(request, { subject: identity.subject, maxBytes: 1024 }))
    await ofzCall(
      PlatformAuthorizationService.method.getPlatformWorkspace,
      { administrator: platformSession(identity), workspaceId },
      request.signal,
    )
    const person = await resolveGithubIdentity(body.login)
    return Response.json({ ...person, name: body.login }, { headers: noStoreHeaders() })
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: 'Enter a GitHub username' }, { status: 400, headers: noStoreHeaders() })
    return platformRouteError(error)
  }
}
