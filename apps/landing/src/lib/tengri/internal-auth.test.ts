import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { signTengriMetadata, signingPayload } from './internal-auth'

describe('Tengri internal request authentication', () => {
  test('signs the exact subject, timestamp, and nonce accepted by the Rust control plane', () => {
    const secret = 's'.repeat(32)
    const metadata = signTengriMetadata('github:42', secret, {
      timestamp: 1_700_000_000,
      nonce: 'nonce-1234567890',
    })
    const expected = createHmac('sha256', secret)
      .update(signingPayload(metadata.subject, metadata.timestamp, metadata.nonce))
      .digest('hex')
    expect(metadata).toEqual({
      subject: 'github:42',
      timestamp: '1700000000',
      nonce: 'nonce-1234567890',
      signature: expected,
    })
  })

  test('rejects caller-controlled identities, weak secrets, and malformed nonces', () => {
    expect(() => signTengriMetadata('email:user@example.com', 's'.repeat(32))).toThrow('identity')
    expect(() => signTengriMetadata('github:42', 'short')).toThrow('secret')
    expect(() =>
      signTengriMetadata('github:42', 's'.repeat(32), { nonce: 'bad nonce', timestamp: 1_700_000_000 }),
    ).toThrow('nonce')
  })
})
