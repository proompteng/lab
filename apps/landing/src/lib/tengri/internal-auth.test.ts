import { createHash, createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { signTengriMetadata, signingPayload } from './internal-auth'

describe('Tengri internal request authentication', () => {
  test('signs the exact subject, timestamp, and nonce accepted by the Rust control plane', () => {
    const secret = 's'.repeat(32)
    const metadata = signTengriMetadata('github:42', secret, {
      rpcPath: '/proompteng.runtime.v1.MicroVMControlPlane/GetAgent',
      body: new Uint8Array([10, 7, 97, 103, 101, 110, 116, 45, 49]),
      timestamp: 1_700_000_000,
      nonce: 'nonce-1234567890',
    })
    const bodyHash = createHash('sha256')
      .update(new Uint8Array([10, 7, 97, 103, 101, 110, 116, 45, 49]))
      .digest('hex')
    const expected = createHmac('sha256', secret)
      .update(
        signingPayload(
          metadata.subject,
          metadata.timestamp,
          metadata.nonce,
          '/proompteng.runtime.v1.MicroVMControlPlane/GetAgent',
          bodyHash,
        ),
      )
      .digest('hex')
    expect(metadata).toEqual({
      subject: 'github:42',
      timestamp: '1700000000',
      nonce: 'nonce-1234567890',
      signature: expected,
    })
  })

  test('rejects caller-controlled identities, weak secrets, and malformed nonces', () => {
    const request = {
      rpcPath: '/proompteng.runtime.v1.MicroVMControlPlane/GetAgent',
      body: new Uint8Array(),
    }
    expect(() => signTengriMetadata('email:user@example.com', 's'.repeat(32), request)).toThrow('identity')
    expect(() => signTengriMetadata('github:42', 'short', request)).toThrow('secret')
    expect(() =>
      signTengriMetadata('github:42', 's'.repeat(32), {
        ...request,
        nonce: 'bad nonce',
        timestamp: 1_700_000_000,
      }),
    ).toThrow('nonce')
    expect(() =>
      signTengriMetadata('github:42', 's'.repeat(32), {
        ...request,
        rpcPath: '/untrusted/DeleteAgent',
      }),
    ).toThrow('RPC')
  })

  test('binds signatures to both the RPC and serialized request body', () => {
    const secret = 's'.repeat(32)
    const base = {
      rpcPath: '/proompteng.runtime.v1.MicroVMControlPlane/GetAgent',
      body: new Uint8Array([10, 1, 97]),
      timestamp: 1_700_000_000,
      nonce: 'nonce-1234567890',
    }

    const original = signTengriMetadata('github:42', secret, base)
    const changedMethod = signTengriMetadata('github:42', secret, {
      ...base,
      rpcPath: '/proompteng.runtime.v1.MicroVMControlPlane/DeleteAgent',
    })
    const changedBody = signTengriMetadata('github:42', secret, {
      ...base,
      body: new Uint8Array([10, 1, 98]),
    })

    expect(changedMethod.signature).not.toBe(original.signature)
    expect(changedBody.signature).not.toBe(original.signature)
  })
})
