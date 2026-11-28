import 'server-only'

import { createHash, createPrivateKey, X509Certificate } from 'node:crypto'
import type { PeerCertificate } from 'node:tls'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { z } from 'zod'

const MAX_IDENTITY_BYTES = 1024 * 1024
const INITIAL_IDENTITY_TIMEOUT_MS = 5_000
const contextSchema = z.object({
  svids: z
    .array(
      z.object({
        spiffeId: z.string(),
        x509Svid: z.instanceof(Uint8Array),
        x509SvidKey: z.instanceof(Uint8Array),
        bundle: z.instanceof(Uint8Array),
      }),
    )
    .max(32),
  crl: z.array(z.instanceof(Uint8Array)).max(0).default([]),
})

export type SpiffeMaterial = {
  certificate: Buffer
  privateKey: Buffer
  bundle: Buffer
  fingerprint: string
  expiresAt: number
}

type IdentityUpdate = { kind: 'ready'; material: SpiffeMaterial } | { kind: 'failed'; error: Error }

export function parseSpiffeId(value: string) {
  if (!/^spiffe:\/\/[a-z0-9.-]+\/[a-zA-Z0-9._/-]+$/.test(value)) throw new Error('Invalid SPIFFE ID')
  const uri = new URL(value)
  if (uri.username || uri.password || uri.port || uri.search || uri.hash || uri.pathname.includes('//')) {
    throw new Error('Invalid SPIFFE ID')
  }
  if (uri.pathname.split('/').some((part) => part === '.' || part === '..') || uri.href !== value) {
    throw new Error('Invalid SPIFFE ID')
  }
  return value
}

export function verifySpiffePeer(expectedId: string, certificate: Pick<PeerCertificate, 'subjectaltname'>) {
  if (certificate.subjectaltname !== `URI:${expectedId}`) return new Error('Unexpected Tengri SPIFFE identity')
  return undefined
}

function certificatesFromDer(value: Uint8Array) {
  const bytes = Buffer.from(value)
  if (!bytes.length || bytes.length > MAX_IDENTITY_BYTES) throw new Error('Invalid SPIFFE certificate sequence')
  const certificates: X509Certificate[] = []
  let offset = 0
  while (offset < bytes.length) {
    if (certificates.length >= 256 || bytes[offset] !== 0x30) throw new Error('Invalid SPIFFE certificate sequence')
    const firstLength = bytes[offset + 1]
    if (firstLength === undefined) throw new Error('Truncated SPIFFE certificate')
    let headerLength = 2
    let length = firstLength
    if (firstLength & 0x80) {
      const octets = firstLength & 0x7f
      if (octets < 1 || octets > 4 || offset + 2 + octets > bytes.length) throw new Error('Invalid SPIFFE DER length')
      length = bytes.readUIntBE(offset + 2, octets)
      if (length < 128) throw new Error('Invalid SPIFFE DER length')
      headerLength += octets
    }
    const end = offset + headerLength + length
    if (end > bytes.length) throw new Error('Truncated SPIFFE certificate')
    certificates.push(new X509Certificate(bytes.subarray(offset, end)))
    offset = end
  }
  return certificates
}

export function parseSpiffeMaterial(value: unknown, expectedId: string, now = Date.now()): SpiffeMaterial {
  const context = contextSchema.parse(value)
  const svid = context.svids.find((candidate) => candidate.spiffeId === expectedId)
  if (!svid) throw new Error('SPIRE did not issue the configured workload identity')
  const chain = certificatesFromDer(svid.x509Svid)
  const leaf = chain[0]
  if (!leaf || leaf.ca || verifySpiffePeer(expectedId, { subjectaltname: leaf.subjectAltName })) {
    throw new Error('Invalid workload SPIFFE identity')
  }
  const expiresAt = Date.parse(leaf.validTo)
  if (Date.parse(leaf.validFrom) > now || expiresAt <= now)
    throw new Error('SPIFFE identity is outside its validity window')
  if (!svid.x509SvidKey.length || svid.x509SvidKey.length > 16 * 1024) throw new Error('Invalid SPIFFE private key')
  const key = createPrivateKey({ key: Buffer.from(svid.x509SvidKey), format: 'der', type: 'pkcs8' })
  if (!leaf.checkPrivateKey(key)) throw new Error('SPIFFE identity does not match its private key')
  const bundle = certificatesFromDer(svid.bundle)
  if (bundle.some((authority) => !authority.ca)) throw new Error('SPIFFE bundle contains a non-CA certificate')
  return {
    certificate: Buffer.from(chain.map((certificate) => certificate.toString()).join('\n')),
    privateKey: Buffer.from(key.export({ format: 'pem', type: 'pkcs8' })),
    bundle: Buffer.from(bundle.map((certificate) => certificate.toString()).join('\n')),
    fingerprint: createHash('sha256').update(svid.x509Svid).update(svid.bundle).digest('hex'),
    expiresAt,
  }
}

export class SpiffeSource {
  private readonly client: grpc.Client
  private readonly method: protoLoader.MethodDefinition<object, object>
  private readonly expectedId: string
  private current: SpiffeMaterial | null = null
  private stream: grpc.ClientReadableStream<unknown> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly waiters = new Set<(update: IdentityUpdate) => void>()

  constructor(config: { endpoint: string; spiffeId: string; protoPath: string }) {
    if (!/^unix:\/\/\/[^?#]+$/.test(config.endpoint) || config.endpoint.includes('\0'))
      throw new Error('SPIFFE Workload API requires an absolute Unix socket')
    this.expectedId = parseSpiffeId(config.spiffeId)
    const definition = protoLoader.loadSync(config.protoPath, { keepCase: false, defaults: true })
    const service = definition.SpiffeWorkloadAPI
    if (!service || !('FetchX509SVID' in service)) throw new Error('SPIFFE Workload API definition is missing')
    this.method = service.FetchX509SVID
    // The standard Workload API is a private Unix socket. Application network connections use mTLS.
    this.client = new grpc.Client(config.endpoint, grpc.credentials.createInsecure(), {
      'grpc.max_receive_message_length': MAX_IDENTITY_BYTES,
    })
    this.watch()
  }

  async material(): Promise<SpiffeMaterial> {
    if (this.closed) throw new Error('SPIFFE source is closed')
    if (this.current && this.current.expiresAt > Date.now()) return this.current
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error('SPIFFE workload identity is unavailable'))
      }, INITIAL_IDENTITY_TIMEOUT_MS)
      const waiter = (update: IdentityUpdate) => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        if (update.kind === 'ready') resolve(update.material)
        else reject(update.error)
      }
      this.waiters.add(waiter)
    })
  }

  close() {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    this.stream?.cancel()
    this.client.close()
    this.current = null
    this.publish({ kind: 'failed', error: new Error('SPIFFE source is closed') })
  }

  private publish(update: IdentityUpdate) {
    for (const waiter of this.waiters) waiter(update)
  }

  private watch() {
    if (this.closed) return
    const metadata = new grpc.Metadata()
    metadata.set('workload.spiffe.io', 'true')
    const stream = this.client.makeServerStreamRequest(
      this.method.path,
      this.method.requestSerialize,
      this.method.responseDeserialize,
      {},
      metadata,
    )
    this.stream = stream
    stream.on('data', (value: unknown) => {
      if (this.closed || this.stream !== stream) return
      try {
        this.current = parseSpiffeMaterial(value, this.expectedId)
        this.publish({ kind: 'ready', material: this.current })
      } catch {
        this.current = null
        this.publish({ kind: 'failed', error: new Error('SPIRE returned an invalid workload identity') })
        stream.cancel()
      }
    })
    stream.on('error', (error: grpc.ServiceError) => {
      if (error.code === grpc.status.PERMISSION_DENIED || error.code === grpc.status.UNAUTHENTICATED) {
        this.current = null
        this.publish({ kind: 'failed', error: new Error('SPIRE denied workload identity') })
      }
      this.reconnect(stream)
    })
    stream.on('end', () => this.reconnect(stream))
  }

  private reconnect(stream: grpc.ClientReadableStream<unknown>) {
    if (this.closed || this.stream !== stream || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.watch()
    }, 1_000)
    this.retry.unref()
  }
}
