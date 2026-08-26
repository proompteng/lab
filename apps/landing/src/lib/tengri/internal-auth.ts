import { createHmac, randomBytes } from 'node:crypto'

export type SignedTengriMetadata = {
  subject: string
  timestamp: string
  nonce: string
  signature: string
}

export function signTengriMetadata(
  subject: string,
  secret: string,
  options: { timestamp?: number; nonce?: string } = {},
): SignedTengriMetadata {
  if (!/^github:\d+$/.test(subject)) throw new Error('Tengri identity is invalid')
  if (secret.trim().length < 32) throw new Error('Tengri signing secret is not configured')
  const timestamp = Math.floor(options.timestamp ?? Date.now() / 1_000).toString()
  const nonce = options.nonce ?? randomBytes(24).toString('base64url')
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error('Tengri request nonce is invalid')
  const signature = createHmac('sha256', secret)
    .update(signingPayload(subject, timestamp, nonce))
    .digest('hex')
  return { subject, timestamp, nonce, signature }
}

export function signingPayload(subject: string, timestamp: string, nonce: string) {
  return `${subject}\n${timestamp}\n${nonce}`
}
