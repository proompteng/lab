import { browserErrorConfig } from '@/lib/observability/errors'

export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json(browserErrorConfig() ?? {}, { headers: { 'Cache-Control': 'no-store' } })
}
