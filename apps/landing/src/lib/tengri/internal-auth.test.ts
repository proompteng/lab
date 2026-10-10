import { create, fromBinary } from '@bufbuild/protobuf'
import { describe, expect, test } from 'bun:test'
import vector from '../../../../../services/tengri/fixtures/ofz-request-v1.json'
import { ActorSchema, RequestContextSchema } from './generated/proompteng/authz/v1/authz_pb'
import { signTengriMetadata } from './internal-auth'

const context = () => fromBinary(RequestContextSchema, Buffer.from(vector.contextBase64, 'base64'))
const request = {
  rpcPath: vector.rpcPath,
  body: Buffer.from(vector.bodyHex, 'hex'),
  nonce: vector.nonce,
  nowUnixMs: vector.nowUnixMs,
}
const generation = BigInt(vector.recoveryGeneration)

describe('Tengri signed Ofz context', () => {
  test('matches the independent HMAC vector also verified by Rust', () => {
    const signed = signTengriMetadata(context(), generation, vector.keyHex, request)
    expect(signed.signature).toBe(vector.signature)
    expect(Buffer.from(signed.context).toString('base64')).toBe(vector.contextBase64)
    expect(signed.recoveryGeneration).toBe(vector.recoveryGeneration)
    expect(signed).not.toHaveProperty('subject')
    expect(signed).not.toHaveProperty('previousSignature')
  })

  test('binds the body, RPC, actor, session, UID, epoch, origin, deadline and recovery generation', () => {
    const original = signTengriMetadata(context(), generation, vector.keyHex, request).signature
    for (const changed of [
      { actor: create(ActorSchema, { identity: { case: 'humanId', value: 'b'.repeat(64) } }) },
      { sessionId: '55555555-5555-4555-8555-555555555555' },
      { workspaceUid: '55555555-5555-4555-8555-555555555555' },
      { runtimeEpoch: '55555555-5555-4555-8555-555555555555' },
      { origin: 'https://other.example' },
      { deadlineUnixMs: BigInt(vector.nowUnixMs + 4000) },
    ]) {
      expect(
        signTengriMetadata(
          create(RequestContextSchema, { ...context(), ...changed }),
          generation,
          vector.keyHex,
          request,
        ).signature,
      ).not.toBe(original)
    }
    expect(signTengriMetadata(context(), generation + BigInt(1), vector.keyHex, request).signature).not.toBe(original)
    expect(
      signTengriMetadata(context(), generation, vector.keyHex, { ...request, body: new Uint8Array([1]) }).signature,
    ).not.toBe(original)
    expect(
      signTengriMetadata(context(), generation, vector.keyHex, {
        ...request,
        rpcPath: '/proompteng.runtime.v1.MicroVMControlPlane/ListAgents',
      }).signature,
    ).not.toBe(original)
  })

  test('rejects incomplete context, noncanonical credentials, old key bundles and expired decisions', () => {
    for (const changed of [
      {
        actor: create(ActorSchema, { identity: { case: 'workloadId', value: 'spiffe://untrusted.example/workload' } }),
      },
      { actor: create(ActorSchema, { identity: { case: 'humanId', value: 'github:42' } }) },
      { sessionId: '' },
      { sessionId: '00000000-0000-0000-0000-000000000000' },
      { traceId: '' },
      { grantId: '55555555-5555-4555-8555-555555555555' },
      { workspaceUid: 'tengri/agent' },
      { runtimeEpoch: '1' },
      { contractVersion: 0 },
      { origin: 'http://proompteng.ai' },
      { origin: 'https://proompteng.ai/' },
      { deadlineUnixMs: BigInt(vector.nowUnixMs) },
      { deadlineUnixMs: BigInt(vector.nowUnixMs + 5001) },
    ]) {
      expect(() =>
        signTengriMetadata(
          create(RequestContextSchema, { ...context(), ...changed }),
          generation,
          vector.keyHex,
          request,
        ),
      ).toThrow()
    }
    for (const key of ['short', '68'.repeat(31), 'A'.repeat(64), `${vector.keyHex},${vector.keyHex}`]) {
      expect(() => signTengriMetadata(context(), generation, key, request)).toThrow('key')
    }
    for (const nonce of ['short', `${vector.nonce}=`, `${vector.nonce.slice(0, -1)}9`, 'a'.repeat(44)]) {
      expect(() => signTengriMetadata(context(), generation, vector.keyHex, { ...request, nonce })).toThrow('nonce')
    }
    expect(() => signTengriMetadata(context(), BigInt(0), vector.keyHex, request)).toThrow()
    expect(() =>
      signTengriMetadata(context(), generation, vector.keyHex, { ...request, rpcPath: '/untrusted/GetAgent' }),
    ).toThrow('RPC')
  })

  test('allocates a canonical independent 256-bit nonce for each request', () => {
    const first = signTengriMetadata(context(), generation, vector.keyHex, { ...request, nonce: undefined })
    const next = signTengriMetadata(context(), generation, vector.keyHex, { ...request, nonce: undefined })
    expect(first.nonce).toHaveLength(43)
    expect(first.nonce).not.toBe(next.nonce)
    expect(first.signature).not.toBe(next.signature)
  })
})
