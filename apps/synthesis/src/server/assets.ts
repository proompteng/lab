import { createHash, createHmac, randomUUID } from 'node:crypto'

import type { AttachmentInput, SynthesisAttachment } from './schema'

type AssetStorageConfig = {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  maxBytes: number
}

type MaterializeAttachmentOptions = {
  now?: () => Date
  fetch?: typeof fetch
}

const defaultMaxBytes = 8 * 1024 * 1024

const normalizeNonEmpty = (value: string | undefined | null) => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

const resolveAssetStorageConfig = (
  env: Record<string, string | undefined> = process.env,
): AssetStorageConfig | null => {
  const required = env.SYNTHESIS_ASSET_STORAGE_REQUIRED === '1' || env.SYNTHESIS_ASSET_STORAGE_REQUIRED === 'true'
  const endpoint = normalizeNonEmpty(env.SYNTHESIS_ASSET_ENDPOINT)
  const bucket = normalizeNonEmpty(env.SYNTHESIS_ASSET_BUCKET)
  const accessKeyId = normalizeNonEmpty(env.SYNTHESIS_ASSET_ACCESS_KEY_ID)
  const secretAccessKey = normalizeNonEmpty(env.SYNTHESIS_ASSET_SECRET_ACCESS_KEY)
  if (!endpoint && !bucket && !accessKeyId && !secretAccessKey) {
    if (required) {
      throw new Error('asset storage is required but SYNTHESIS_ASSET_* configuration is missing')
    }
    return null
  }
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'asset storage requires SYNTHESIS_ASSET_ENDPOINT, SYNTHESIS_ASSET_BUCKET, SYNTHESIS_ASSET_ACCESS_KEY_ID, and SYNTHESIS_ASSET_SECRET_ACCESS_KEY',
    )
  }

  return {
    endpoint: endpoint.startsWith('http://') || endpoint.startsWith('https://') ? endpoint : `https://${endpoint}`,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: normalizeNonEmpty(env.SYNTHESIS_ASSET_REGION) ?? 'us-east-1',
    maxBytes: Number(normalizeNonEmpty(env.SYNTHESIS_ASSET_MAX_BYTES) ?? defaultMaxBytes),
  }
}

const awsEncode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const encodePath = (path: string) =>
  path
    .split('/')
    .map((segment) => awsEncode(segment))
    .join('/')
    .replace(/\/+/g, '/')

const sha256Hex = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest()
const hmacHex = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest('hex')

const signingKey = (secretKey: string, datestamp: string, region: string) => {
  const dateKey = hmac(`AWS4${secretKey}`, datestamp)
  const regionKey = hmac(dateKey, region)
  const serviceKey = hmac(regionKey, 's3')
  return hmac(serviceKey, 'aws4_request')
}

const toAmzDates = (date: Date) => {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return {
    amzDate: iso,
    datestamp: iso.slice(0, 8),
  }
}

const normalizeKey = (key: string) =>
  key
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')

const buildObjectUrl = (config: AssetStorageConfig, key: string) => {
  const endpoint = new URL(config.endpoint)
  const basePath = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/$/, '')
  const canonicalUri = encodePath(`${basePath}/${config.bucket}/${normalizeKey(key)}`)
  endpoint.pathname = canonicalUri
  endpoint.search = ''
  return { url: endpoint.toString(), canonicalUri, host: endpoint.host }
}

const signedS3Request = (input: {
  config: AssetStorageConfig
  key: string
  method: 'GET' | 'PUT'
  body?: Buffer
  contentType?: string
  now: Date
}) => {
  const { amzDate, datestamp } = toAmzDates(input.now)
  const payloadHash = input.body ? sha256Hex(input.body) : sha256Hex('')
  const { url, canonicalUri, host } = buildObjectUrl(input.config, input.key)
  const headers = {
    ...(input.contentType ? { 'content-type': input.contentType } : {}),
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join('\n')
    .concat('\n')
  const canonicalRequest = [input.method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${datestamp}/${input.config.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(signingKey(input.config.secretAccessKey, datestamp, input.config.region), stringToSign)
  return {
    url,
    headers: {
      Authorization: [
        `AWS4-HMAC-SHA256 Credential=${input.config.accessKeyId}/${scope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`,
      ].join(', '),
      ...(input.contentType ? { 'content-type': input.contentType } : {}),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  }
}

const extensionForMime = (mimeType: string) => {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/avif') return 'avif'
  return 'bin'
}

const assertSupportedMime = (mimeType: string) => {
  if (!mimeType.toLowerCase().startsWith('image/')) {
    throw new Error(`unsupported synthesis asset MIME type: ${mimeType}`)
  }
}

const isLikelyRenderableImageUrl = (url: string) =>
  /^https?:\/\/[^/]*pbs\.twimg\.com\/media\//i.test(url) ||
  /^https?:\/\/[^/]*twimg\.com\//i.test(url) ||
  /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url)

const assertRenderableRemoteImageUrl = (url: string) => {
  if (isLikelyRenderableImageUrl(url)) return
  throw new Error(`asset URL must be a direct image URL or data URL: ${url}`)
}

const parseDataUrl = (url: string): { body: Buffer; mimeType: string } | null => {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) return null
  return {
    mimeType: match[1],
    body: Buffer.from(match[2], 'base64'),
  }
}

const readRemoteAsset = async (url: string, maxBytes: number, fetchImpl: typeof fetch) => {
  const response = await fetchImpl(url, { headers: { accept: 'image/*,*/*;q=0.5' } })
  if (!response.ok) throw new Error(`asset download failed for ${url}: ${response.status}`)
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  assertSupportedMime(mimeType)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > maxBytes) throw new Error(`asset exceeds max size: ${body.length} > ${maxBytes}`)
  return { body, mimeType }
}

const materializeBody = async (
  input: AttachmentInput,
  config: AssetStorageConfig,
  fetchImpl: typeof fetch,
): Promise<{ body: Buffer; mimeType: string } | null> => {
  if (input.data) {
    const data = parseDataUrl(input.data)
    if (!data) throw new Error('attachment data must be a base64 data URL')
    assertSupportedMime(data.mimeType)
    if (data.body.length > config.maxBytes)
      throw new Error(`asset exceeds max size: ${data.body.length} > ${config.maxBytes}`)
    return data
  }
  if (input.url?.startsWith('data:')) {
    const data = parseDataUrl(input.url)
    if (!data) throw new Error('attachment URL data must be a base64 data URL')
    assertSupportedMime(data.mimeType)
    if (data.body.length > config.maxBytes)
      throw new Error(`asset exceeds max size: ${data.body.length} > ${config.maxBytes}`)
    return data
  }
  if (input.url) {
    assertRenderableRemoteImageUrl(input.url)
    return readRemoteAsset(input.url, config.maxBytes, fetchImpl)
  }
  return null
}

export const normalizeAttachmentInputs = (input: {
  attachments: AttachmentInput[]
  generatedAttachments: AttachmentInput[]
  mediaUrls: string[]
}) => {
  const normalized: Array<AttachmentInput & { generated: boolean }> = []
  for (const attachment of input.attachments) normalized.push({ ...attachment, generated: false })
  for (const attachment of input.generatedAttachments) normalized.push({ ...attachment, generated: true })
  for (const url of input.mediaUrls) {
    normalized.push({ kind: 'source_image', url, sourceUrl: url, generated: false })
  }
  return normalized
}

export const materializeAttachments = async (
  inputs: Array<AttachmentInput & { generated: boolean }>,
  options: MaterializeAttachmentOptions = {},
): Promise<SynthesisAttachment[]> => {
  if (inputs.length === 0) return []

  const config = resolveAssetStorageConfig()
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const seen = new Set<string>()
  const attachments: SynthesisAttachment[] = []

  for (const input of inputs) {
    const identity = `${input.kind}:${input.url ?? input.data ?? input.sourceUrl ?? ''}`
    if (seen.has(identity)) continue
    seen.add(identity)

    const id = randomUUID()
    const sourceUrl = input.url?.startsWith('data:') ? null : (input.url ?? input.sourceUrl ?? null)
    let objectKey: string | null = null
    let assetUrl = input.url ?? input.data ?? ''
    let mimeType = input.mimeType ?? null
    let sizeBytes: number | null = null

    if (input.data || input.url?.startsWith('data:')) {
      const data = parseDataUrl(input.data ?? input.url ?? '')
      if (!data) throw new Error('attachment data must be a base64 data URL')
      assertSupportedMime(data.mimeType)
      mimeType = data.mimeType
      sizeBytes = data.body.length
      if (sizeBytes > (config?.maxBytes ?? defaultMaxBytes)) {
        throw new Error(`asset exceeds max size: ${sizeBytes} > ${config?.maxBytes ?? defaultMaxBytes}`)
      }
    } else if (input.url) {
      assertRenderableRemoteImageUrl(input.url)
      if (mimeType) assertSupportedMime(mimeType)
    } else if (mimeType) {
      assertSupportedMime(mimeType)
    }

    if (config) {
      const body = await materializeBody(input, config, fetchImpl)
      if (body) {
        mimeType = body.mimeType
        sizeBytes = body.body.length
        objectKey = `synthesis/${now().toISOString().slice(0, 10)}/${id}.${extensionForMime(body.mimeType)}`
        const request = signedS3Request({
          config,
          key: objectKey,
          method: 'PUT',
          body: body.body,
          contentType: body.mimeType,
          now: now(),
        })
        const response = await fetchImpl(request.url, {
          method: 'PUT',
          headers: request.headers,
          body: new Uint8Array(body.body),
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(`asset upload failed for s3://${config.bucket}/${objectKey}: ${response.status} ${text}`)
        }
        assetUrl = `/api/assets/${id}`
      }
    } else if (sourceUrl) {
      assetUrl = `/api/assets/${id}`
    }

    attachments.push({
      id,
      kind: input.kind,
      sourceUrl,
      assetUrl,
      objectKey,
      mimeType,
      sizeBytes,
      alt: input.alt ?? null,
      label: input.label ?? null,
      generated: input.generated,
    })
  }

  return attachments
}

export const assetResponseForAttachment = async (attachment: SynthesisAttachment): Promise<Response> => {
  if (attachment.objectKey) {
    const config = resolveAssetStorageConfig()
    if (!config) return new Response('asset storage unavailable', { status: 503 })
    const request = signedS3Request({ config, key: attachment.objectKey, method: 'GET', now: new Date() })
    const response = await fetch(request.url, { headers: request.headers })
    if (!response.ok) return new Response('asset not found', { status: response.status })
    const contentType = attachment.mimeType ?? response.headers.get('content-type')
    return new Response(response.body, {
      status: 200,
      headers: {
        'cache-control': 'private, max-age=3600',
        ...(contentType ? { 'content-type': contentType } : {}),
      },
    })
  }

  if (attachment.assetUrl.startsWith('data:')) {
    const data = parseDataUrl(attachment.assetUrl)
    if (!data) return new Response('invalid inline asset', { status: 404 })
    return new Response(new Uint8Array(data.body), {
      headers: {
        'cache-control': 'private, max-age=3600',
        'content-type': data.mimeType,
      },
    })
  }

  const redirectUrl = attachment.sourceUrl ?? attachment.assetUrl
  if (redirectUrl.startsWith('http://') || redirectUrl.startsWith('https://')) {
    return Response.redirect(redirectUrl, 302)
  }

  return new Response('asset not found', { status: 404 })
}
