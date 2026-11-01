import 'server-only'

import type { PlatformIdentity } from './auth'
import { PlatformRequestError, requirePlatformIdentity } from './http'

export function isAdminPortal() {
  return process.env.PLATFORM_PORTAL === 'admin'
}

export async function requireAdminIdentity(request: Request) {
  if (!isAdminPortal()) throw new PlatformRequestError('Not found', 404)
  return requirePlatformIdentity(request)
}

export function platformSession(identity: PlatformIdentity) {
  return {
    humanId: identity.session.humanId,
    sessionId: identity.session.id,
    origin: new URL(process.env.PLATFORM_WEB_ORIGIN || '').origin,
  }
}
