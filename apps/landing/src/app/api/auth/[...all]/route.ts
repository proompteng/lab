import { observeRequest } from '@/lib/observability/server'
import { handlePlatformAuth } from '@/lib/platform/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return observeRequest(request, 'auth.request', () => handlePlatformAuth(request))
}

export async function POST(request: Request) {
  return observeRequest(request, 'auth.request', () => handlePlatformAuth(request))
}

export function HEAD() {
  return new Response(null, { status: 405, headers: { 'Cache-Control': 'no-store' } })
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
