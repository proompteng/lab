import { NextResponse } from 'next/server'

import { buildRuntimeContentSecurityPolicy } from '@/lib/tengri/security-headers'

export function proxy() {
  const response = NextResponse.next()
  // The gateway is a deployment-time setting, so this policy must not be frozen into the image by next.config.ts.
  response.headers.set('Content-Security-Policy', buildRuntimeContentSecurityPolicy())

  return response
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
}
