import { z } from 'zod'
import { cookie, platformSession } from '@/lib/platform/auth'
import { noStoreHeaders, requirePlatformIdentity, PlatformRequestError, platformRouteError } from '@/lib/platform/http'
import { ofzCall } from '@/lib/platform/ofz'
import { providerId, providerReturnPath, type ProviderResult } from '@/lib/platform/provider-connections'
import {
  PlatformAuthorizationService,
  ProviderConnectionProblem,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

export const dynamic = 'force-dynamic'
export async function GET(request: Request, context: { params: Promise<{ profileId: string }> }) {
  try {
    const profileId = providerId.parse((await context.params).profileId)
    const query = z
      .object({
        state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code: z.string().max(8192).optional(),
        error: z.string().max(128).optional(),
        iss: z.string().max(2048).optional(),
      })
      .parse(Object.fromEntries(new URL(request.url).searchParams))
    const binding = cookie(request.headers, '__Host-platform-provider')
    if (!binding)
      throw new PlatformRequestError('This account connection belongs to another browser or has expired.', 403)
    const identity = await requirePlatformIdentity(request)
    const result = await ofzCall(
      PlatformAuthorizationService.method.completeProviderConnection,
      {
        human: platformSession(identity),
        profileId,
        state: query.state,
        binding,
        code: query.code,
        error: query.error,
        issuer: query.iss,
      },
      request.signal,
    )
    const path = providerReturnPath.parse(result.returnPath)
    const target = new URL(path, platformSession(identity).origin)
    if (target.origin !== platformSession(identity).origin)
      throw new PlatformRequestError('Invalid account return path', 400)
    const outcome: ProviderResult =
      result.connected && result.problem === ProviderConnectionProblem.UNSPECIFIED
        ? 'connected'
        : result.problem === ProviderConnectionProblem.CANCELLED
          ? 'cancelled'
          : result.problem === ProviderConnectionProblem.ACCOUNT_MISMATCH
            ? 'account-mismatch'
            : result.problem === ProviderConnectionProblem.ACCESS_REMOVED
              ? 'access-removed'
              : 'failed'
    target.searchParams.set('platform_connection', outcome)
    target.searchParams.set('provider_profile', profileId)
    return new Response(null, {
      status: 303,
      headers: { ...noStoreHeaders(), 'Referrer-Policy': 'no-referrer', Location: target.href },
    })
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        { error: 'The account authorization response is invalid.' },
        { status: 400, headers: { ...noStoreHeaders(), 'Referrer-Policy': 'no-referrer' } },
      )
    return platformRouteError(error)
  }
}
