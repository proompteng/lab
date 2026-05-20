#!/usr/bin/env bun
import { createHash, createHmac } from 'node:crypto'

const requireEnv = (key: string) => {
  const value = process.env[key]
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${key}`)
  }
  return value.trim()
}

const normalizeEndpoint = (endpoint: string, secure: boolean) => {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint
  }
  return `${secure ? 'https' : 'http'}://${endpoint}`
}

const parseBool = (value: string | undefined) => {
  if (!value) return false
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
}

const DEFAULT_BUCKET = 'agents-artifacts'

const awsEncode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const encodePath = (path: string) =>
  path
    .split('/')
    .map((segment) => awsEncode(segment))
    .join('/')
    .replace(/\/+/g, '/')

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest()

const hmacHex = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest('hex')

const toAmzDates = (date: Date) => {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return {
    amzDate: iso,
    datestamp: iso.slice(0, 8),
  }
}

const canonicalQuery = (params: Record<string, string>) =>
  Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join('&')

const signingKey = (secretKey: string, datestamp: string, region: string) => {
  const dateKey = hmac(`AWS4${secretKey}`, datestamp)
  const regionKey = hmac(dateKey, region)
  const serviceKey = hmac(regionKey, 's3')
  return hmac(serviceKey, 'aws4_request')
}

const buildSignedListUrl = (input: {
  endpoint: string
  accessKey: string
  secretKey: string
  bucket: string
  region: string
  now?: Date
}) => {
  const endpoint = new URL(input.endpoint)
  const { amzDate, datestamp } = toAmzDates(input.now ?? new Date())
  const scope = `${datestamp}/${input.region}/s3/aws4_request`
  const basePath = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/$/, '')
  const canonicalUri = encodePath(`${basePath}/${input.bucket}`)
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '60',
    'X-Amz-SignedHeaders': 'host',
    'list-type': '2',
    'max-keys': '1',
  }
  const query = canonicalQuery(params)
  const canonicalRequest = ['GET', canonicalUri, query, `host:${endpoint.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join(
    '\n',
  )
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(signingKey(input.secretKey, datestamp, input.region), stringToSign)
  endpoint.pathname = canonicalUri
  endpoint.search = `${query}&X-Amz-Signature=${signature}`
  return endpoint.toString()
}

const main = async () => {
  const endpointRaw = requireEnv('MINIO_ENDPOINT')
  const accessKey = requireEnv('MINIO_ACCESS_KEY')
  const secretKey = requireEnv('MINIO_SECRET_KEY')
  const bucket = (process.env.MINIO_BUCKET ?? process.env.ARTIFACT_BUCKET ?? DEFAULT_BUCKET).trim()
  if (!bucket) {
    throw new Error('Missing MINIO_BUCKET')
  }

  const secure = parseBool(process.env.MINIO_SECURE) || endpointRaw.startsWith('https://')
  const endpoint = normalizeEndpoint(endpointRaw, secure)
  const region = process.env.MINIO_REGION ?? 'us-east-1'

  const url = buildSignedListUrl({
    endpoint,
    accessKey,
    secretKey,
    bucket,
    region,
  })
  const response = await fetch(url)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`MinIO signed URL check failed (${response.status})${text ? `: ${text}` : ''}`)
  }

  process.stdout.write('ok\n')
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
