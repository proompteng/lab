import 'server-only'

import { PlatformRequestError, requirePlatformIdentity } from './http'

export function isAdminPortal() {
  return process.env.PLATFORM_PORTAL === 'admin'
}

export async function requireAdminIdentity(request: Request) {
  if (!isAdminPortal()) throw new PlatformRequestError('Not found', 404)
  return requirePlatformIdentity(request)
}
