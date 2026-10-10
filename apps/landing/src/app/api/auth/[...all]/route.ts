import { handleTengriAuth } from '@/lib/tengri/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return handleTengriAuth(request)
}

export async function POST(request: Request) {
  return handleTengriAuth(request)
}

export function HEAD() {
  return new Response(null, { status: 405, headers: { 'Cache-Control': 'no-store' } })
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
