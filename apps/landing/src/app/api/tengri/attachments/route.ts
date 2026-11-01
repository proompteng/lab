import { observeRequest } from '@/lib/observability/server'
import { isWorkspaceImagePath } from '@/lib/tengri/codex-images'
import { readWorkspaceImage } from '@/lib/tengri/grpc'
import { noStoreHeaders, requireSameOriginGet, requireTengriIdentity, tengriRouteError } from '@/lib/tengri/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return observeRequest(request, 'tengri/attachments.get', async () => {
    try {
      requireSameOriginGet(request)
      const identity = await requireTengriIdentity(request)
      const url = new URL(request.url)
      const agentId = url.searchParams.get('agentId') ?? ''
      const path = url.searchParams.get('path') ?? ''
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(agentId) || !isWorkspaceImagePath(path)) {
        return Response.json({ error: 'Invalid attachment request' }, { status: 400, headers: noStoreHeaders() })
      }
      const { content, mediaType } = await readWorkspaceImage(identity, agentId, path)
      return new Response(new Uint8Array(content), {
        headers: {
          ...noStoreHeaders(),
          'Content-Type': mediaType,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      })
    } catch (error) {
      return tengriRouteError(error)
    }
  })
}
