import { getTengriAuth } from '@/lib/tengri/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}

async function handle(request: Request) {
  const auth = getTengriAuth()
  if (!auth) {
    return Response.json({ error: 'GitHub authentication is not configured' }, { status: 503 })
  }
  return auth.handler(request)
}
