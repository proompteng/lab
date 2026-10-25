import { z } from 'zod'
import { RelayService } from '@/lib/tengri/generated/proompteng/relay/v1/relay_pb'
import { relayCall } from '@/lib/platform/relay'
import { noStoreHeaders, readTengriJsonBody, tengriRouteError } from '@/lib/tengri/http'
import { OfzError } from '@/lib/tengri/ofz'
const envelope = z.strictObject({
  body: z
    .string()
    .min(1)
    .max(87_384)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
})
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    const expected = new URL(process.env.TENGRI_DESKTOP_ORIGIN?.trim() || 'https://proompteng.ai')
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
    const body = Buffer.from(envelope.parse(await readTengriJsonBody(request, { maxBytes: 90_000 })).body, 'base64')
    if (body.length > 65_536) throw new OfzError(400)
    const result = await relayCall(
      RelayService.method.execute,
      {
        subject: {
          clientService: 'tengri-web',
          identity: { case: 'delegation', value: { delegationId, credential, proof } },
        },
        body,
      },
      request.signal,
    )
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
    return tengriRouteError(error)
  }
}
