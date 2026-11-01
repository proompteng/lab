import { z } from 'zod'
import { toJson } from '@bufbuild/protobuf'
import { GetExecutionResponseSchema, RelayService } from '@/lib/tengri/generated/proompteng/relay/v1/relay_pb'
import { relayCall } from '@/lib/platform/relay'
import { relayEnvelope } from '@/lib/platform/relay-envelope'
import { noStoreHeaders, readPlatformJsonBody, platformRouteError } from '@/lib/platform/http'
import { OfzError } from '@/lib/platform/ofz'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    const expected = new URL(process.env.PLATFORM_WEB_ORIGIN?.trim() || 'https://proompteng.ai')
    if (
      request.headers.get('host') !== expected.host ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== expected.origin)
    )
      throw new OfzError(403)
    const credential = request.headers.get('authorization')?.match(/^DPoP ([A-Za-z0-9_-]{43})$/)?.[1]
    const delegationId = z.uuid().parse(request.headers.get('x-relay-delegation'))
    const proof = request.headers.get('dpop') || ''
    if (!credential || proof.length > 16_384 || !proof) throw new OfzError(401)
    const envelope = relayEnvelope.parse(await readPlatformJsonBody(request, { maxBytes: 360_000 }))
    const input = {
      subject: {
        clientService: 'tengri-web',
        identity: { case: 'delegation' as const, value: { delegationId, credential, proof } },
      },
      body: envelope.body,
    }
    if (envelope.kind === 'lookup') {
      const result = await relayCall(RelayService.method.getExecution, input, request.signal)
      return Response.json(toJson(GetExecutionResponseSchema, result), { headers: noStoreHeaders() })
    }
    const result = await relayCall(RelayService.method.execute, input, request.signal)
    return Response.json(
      {
        operationId: result.operationId,
        result: new TextDecoder('utf-8', { fatal: true }).decode(result.result),
        contentType: result.contentType,
        authorizationReceiptId: result.authorizationReceiptId,
        executionReceiptId: result.executionReceiptId,
      },
      { headers: noStoreHeaders() },
    )
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: 'Invalid Relay agent request' }, { status: 400, headers: noStoreHeaders() })
    return platformRouteError(error)
  }
}
