import { createHash, createHmac, randomBytes } from 'node:crypto'
import { toBinary } from '@bufbuild/protobuf'
import { RequestContextSchema, type RequestContext } from './generated/proompteng/authz/v1/authz_pb'

const uuid = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type SignedTengriMetadata = {
  context: Uint8Array
  recoveryGeneration: string
  nonce: string
  signature: string
}

export function signTengriMetadata(
  context: RequestContext,
  recoveryGeneration: bigint,
  key: string,
  options: { rpcPath: string; body: Uint8Array; nonce?: string; nowUnixMs?: number },
): SignedTengriMetadata {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Tengri signing key must be one lowercase hexadecimal key')
  const now = BigInt(options.nowUnixMs ?? Date.now())
  const origin = new URL(context.origin)
  if (
    context.actor?.identity.case !== 'humanId' ||
    !/^[a-f0-9]{64}$/.test(context.actor.identity.value) ||
    !uuid.test(context.sessionId) ||
    !uuid.test(context.traceId) ||
    context.contractVersion !== 1 ||
    context.grantId !== '' ||
    (context.workspaceUid !== '' && !uuid.test(context.workspaceUid)) ||
    (context.runtimeEpoch !== '' && !uuid.test(context.runtimeEpoch)) ||
    context.deadlineUnixMs <= now ||
    context.deadlineUnixMs > now + BigInt(5000) ||
    origin.protocol !== 'https:' ||
    origin.origin !== context.origin ||
    origin.username !== '' ||
    origin.password !== '' ||
    recoveryGeneration <= BigInt(0) ||
    recoveryGeneration > BigInt('18446744073709551615')
  )
    throw new Error('Tengri signed identity, runtime, origin or deadline is invalid')
  if (!/^\/proompteng\.runtime\.v1\.MicroVMControlPlane\/[A-Z][A-Za-z0-9]+$/.test(options.rpcPath)) {
    throw new Error('Tengri RPC identity is invalid')
  }
  const nonce = options.nonce ?? randomBytes(32).toString('base64url')
  const nonceBytes = Buffer.from(nonce, 'base64url')
  if (nonceBytes.length !== 32 || nonceBytes.toString('base64url') !== nonce) {
    throw new Error('Tengri request nonce is invalid')
  }
  const bytes = toBinary(RequestContextSchema, context)
  if (bytes.length > 2048) throw new Error('Tengri request context exceeds its bound')
  const payload = signingPayload(options.rpcPath, options.body, nonce, bytes, recoveryGeneration)
  return {
    context: bytes,
    recoveryGeneration: recoveryGeneration.toString(),
    nonce,
    signature: createHmac('sha256', Buffer.from(key, 'hex')).update(payload).digest('hex'),
  }
}

export function signingPayload(
  rpcPath: string,
  body: Uint8Array,
  nonce: string,
  context: Uint8Array,
  recoveryGeneration: bigint,
) {
  return `tengri.ofz.v1\n${rpcPath}\n${createHash('sha256').update(body).digest('hex')}\n${nonce}\n${Buffer.from(context).toString('base64url')}\n${recoveryGeneration}`
}
