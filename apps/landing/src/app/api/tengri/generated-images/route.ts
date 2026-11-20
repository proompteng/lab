import { observeRequest } from '@/lib/observability/server'
import { parseCodexGeneratedImagePath } from '@/lib/tengri/codex-images'
import { readCodexGeneratedImage } from '@/lib/tengri/grpc'
import { noStoreHeaders, requireSameOriginGet, requirePlatformIdentity, platformRouteError } from '@/lib/platform/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return observeRequest(request, 'tengri/generated-images.get', async () => {
    try {
      requireSameOriginGet(request)
      const identity = await requirePlatformIdentity(request)
      const url = new URL(request.url)
      const agentId = url.searchParams.get('agentId') ?? ''
      const image = parseCodexGeneratedImagePath(url.searchParams.get('path') ?? '')
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(agentId) || !image) {
        return Response.json({ error: 'Invalid generated image request' }, { status: 400, headers: noStoreHeaders() })
      }
      const { content, mediaType } = await readCodexGeneratedImage(identity, agentId, image.path, request.signal)
      return new Response(new Uint8Array(content), {
        headers: {
          ...noStoreHeaders(),
          'Content-Type': mediaType,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      })
    } catch (error) {
      return platformRouteError(error)
    }
  })
}
