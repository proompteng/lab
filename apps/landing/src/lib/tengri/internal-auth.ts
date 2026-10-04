import { createHash, createHmac, randomBytes } from 'node:crypto'

export type SignedTengriMetadata = {
  subject: string
  timestamp: string
  nonce: string
  signature: string
  previousSignature?: string
}

export function signTengriMetadata(
  subject: string,
  secret: string | readonly string[],
  options: { rpcPath: string; body: Uint8Array; timestamp?: number; nonce?: string },
): SignedTengriMetadata {
  if (!/^github:\d+$/.test(subject)) throw new Error('Tengri identity is invalid')
  const secrets = typeof secret === 'string' ? [secret] : [...secret]
  if (secrets.length === 0 || secrets.length > 2 || secrets.some((value) => value.trim().length < 32)) {
    throw new Error('Tengri signing secret is not configured')
  }
  const timestamp = Math.floor(options.timestamp ?? Date.now() / 1_000).toString()
  const nonce = options.nonce ?? randomBytes(24).toString('base64url')
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error('Tengri request nonce is invalid')
  if (!/^\/proompteng\.runtime\.v1\.MicroVMControlPlane\/[A-Z][A-Za-z0-9]+$/.test(options.rpcPath)) {
    throw new Error('Tengri RPC identity is invalid')
  }
  const bodyHash = createHash('sha256').update(options.body).digest('hex')
  const payload = signingPayload(subject, timestamp, nonce, options.rpcPath, bodyHash)
  const signatures = secrets.map((value) => createHmac('sha256', value.trim()).update(payload).digest('hex'))
  return {
    subject,
    timestamp,
    nonce,
    signature: signatures[0],
    ...(signatures[1] ? { previousSignature: signatures[1] } : {}),
  }
}

export function parseTengriSigningSecrets(bundle: string) {
  const secrets = bundle
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return secrets.length > 0 && secrets.length <= 2 && secrets.every((value) => value.length >= 32) ? secrets : null
}

export function signingPayload(subject: string, timestamp: string, nonce: string, rpcPath: string, bodyHash: string) {
  return `${subject}\n${timestamp}\n${nonce}\n${rpcPath}\n${bodyHash}`
}
