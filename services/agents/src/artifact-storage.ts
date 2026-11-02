import { createHash, createHmac } from 'node:crypto'

export type ArtifactUploadConfig = {
  endpoint: string
  accessKey: string
  secretKey: string
  bucket: string
  region: string
  secure: boolean
}

export type ArtifactUploadOptions = {
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  now?: () => Date
}

const DEFAULT_REGION = 'us-east-1'

const normalizeNonEmpty = (value: string | undefined | null) => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

const parseBool = (value: string | undefined | null) => {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

const firstNonEmpty = (...values: Array<string | undefined | null>) => {
  for (const value of values) {
    const normalized = normalizeNonEmpty(value)
    if (normalized) return normalized
  }
  return null
}

export const resolveArtifactUploadConfig = (
  env: Record<string, string | undefined> = process.env,
): ArtifactUploadConfig | null => {
  const endpointRaw = firstNonEmpty(
    env.AGENTS_ARTIFACTS_ENDPOINT,
    env.MINIO_ENDPOINT,
    env.AWS_ENDPOINT_URL_S3,
    env.AWS_ENDPOINT_URL,
  )
  const accessKey = firstNonEmpty(
    env.AGENTS_ARTIFACTS_ACCESS_KEY_ID,
    env.MINIO_ACCESS_KEY,
    env.AWS_ACCESS_KEY_ID,
    env.accesskey,
  )
  const secretKey = firstNonEmpty(
    env.AGENTS_ARTIFACTS_SECRET_ACCESS_KEY,
    env.MINIO_SECRET_KEY,
    env.AWS_SECRET_ACCESS_KEY,
    env.secretkey,
  )
  const bucket = firstNonEmpty(env.AGENTS_ARTIFACTS_BUCKET, env.MINIO_BUCKET, env.ARTIFACT_BUCKET)
  if (!endpointRaw && !accessKey && !secretKey && !bucket) return null
  if (!endpointRaw || !accessKey || !secretKey || !bucket) {
    throw new Error(
      'artifact upload requires AGENTS_ARTIFACTS_ENDPOINT, AGENTS_ARTIFACTS_ACCESS_KEY_ID, AGENTS_ARTIFACTS_SECRET_ACCESS_KEY, and AGENTS_ARTIFACTS_BUCKET',
    )
  }

  const explicitSecure = parseBool(env.AGENTS_ARTIFACTS_SECURE) || parseBool(env.MINIO_SECURE)
  const endpoint =
    endpointRaw.startsWith('http://') || endpointRaw.startsWith('https://')
      ? endpointRaw
      : `${explicitSecure ? 'https' : 'http'}://${endpointRaw}`

  return {
    endpoint,
    accessKey,
    secretKey,
    bucket,
    region: firstNonEmpty(env.AGENTS_ARTIFACTS_REGION, env.MINIO_REGION, env.AWS_REGION) ?? DEFAULT_REGION,
    secure: endpoint.startsWith('https://'),
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

const toAmzDates = (date: Date) => {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return {
    amzDate: iso,
    datestamp: iso.slice(0, 8),
  }
}

const signingKey = (secretKey: string, datestamp: string, region: string) => {
  const dateKey = hmac(`AWS4${secretKey}`, datestamp)
  const regionKey = hmac(dateKey, region)
  const serviceKey = hmac(regionKey, 's3')
  return hmac(serviceKey, 'aws4_request')
}

export const normalizeArtifactKey = (key: string) =>
  key
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')

const buildObjectUrl = (config: ArtifactUploadConfig, key: string) => {
  const endpoint = new URL(config.endpoint)
  const basePath = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/$/, '')
  const canonicalUri = encodePath(`${basePath}/${config.bucket}/${key}`)
  endpoint.pathname = canonicalUri
  endpoint.search = ''
  return { url: endpoint.toString(), canonicalUri, host: endpoint.host }
}

const requestS3Object = async (input: {
  method: 'GET' | 'PUT'
  range?: string
  timeoutMs?: number
  config: ArtifactUploadConfig
  key: string
  body: Buffer
  fetch: typeof fetch
  now: Date
}) => {
  const key = normalizeArtifactKey(input.key)
  if (!key) throw new Error('artifact upload key is empty')

  const { amzDate, datestamp } = toAmzDates(input.now)
  const payloadHash = sha256Hex(input.body)
  const { url, canonicalUri, host } = buildObjectUrl(input.config, key)
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders = [`host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`, ''].join(
    '\n',
  )
  const canonicalRequest = [input.method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${datestamp}/${input.config.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(signingKey(input.config.secretKey, datestamp, input.config.region), stringToSign)
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${input.config.accessKey}/${scope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ')

  const response = await input.fetch(url, {
    method: input.method,
    redirect: 'error',
    headers: {
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(input.range ? { Range: input.range } : {}),
    },
    ...(input.method === 'PUT' ? { body: new Uint8Array(input.body).buffer } : {}),
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new ArtifactStorageError(
      response.status,
      `artifact ${input.method === 'PUT' ? 'upload' : 'read'} failed for s3://${input.config.bucket}/${key}: HTTP ${response.status}`,
    )
  }
  return response
}

export class ArtifactStorageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type S3ObjectRequest = {
  timeoutMs?: number
  config: ArtifactUploadConfig
  key: string
  fetch: typeof fetch
  now: Date
}

export const putS3Object = async (input: S3ObjectRequest & { body: Buffer }) => {
  await requestS3Object({ ...input, method: 'PUT' })
}

export const getS3ObjectTail = async (input: S3ObjectRequest & { maxBytes?: number }) => {
  const maxBytes = input.maxBytes ?? 524_288
  const response = await requestS3Object({
    ...input,
    method: 'GET',
    body: Buffer.alloc(0),
    range: `bytes=-${maxBytes}`,
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('retained log response has no body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw new Error('retained log response exceeds its byte budget')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  const start = Number(response.headers.get('content-range')?.match(/^bytes (\d+)-/)?.[1] ?? 0)
  const text = Buffer.concat(chunks).toString('utf8')
  const firstNewline = text.indexOf('\n')
  return { text: start > 0 ? (firstNewline < 0 ? '' : text.slice(firstNewline + 1)) : text, truncated: start > 0 }
}
