import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { type AgentProviderOutputArtifact } from './spec'

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

const normalizeKey = (key: string) =>
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

export const putS3Object = async (input: {
  config: ArtifactUploadConfig
  key: string
  body: Buffer
  fetch: typeof fetch
  now: Date
}) => {
  const key = normalizeKey(input.key)
  if (!key) throw new Error('artifact upload key is empty')

  const { amzDate, datestamp } = toAmzDates(input.now)
  const payloadHash = sha256Hex(input.body)
  const { url, canonicalUri, host } = buildObjectUrl(input.config, key)
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders = [`host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`, ''].join(
    '\n',
  )
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${datestamp}/${input.config.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(signingKey(input.config.secretKey, datestamp, input.config.region), stringToSign)
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${input.config.accessKey}/${scope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ')

  const response = await input.fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body: new Uint8Array(input.body).buffer,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `artifact upload failed for s3://${input.config.bucket}/${key}: ${response.status}${text ? ` ${text}` : ''}`,
    )
  }
}

export const uploadOutputArtifacts = async (
  artifacts: AgentProviderOutputArtifact[],
  options: ArtifactUploadOptions = {},
): Promise<AgentProviderOutputArtifact[]> => {
  if (artifacts.length === 0) return []
  const keyed = artifacts.filter((artifact) => normalizeNonEmpty(artifact.key))
  if (keyed.length === 0) return artifacts

  const config = resolveArtifactUploadConfig(options.env)
  if (!config) {
    throw new Error('artifact upload is required for keyed outputArtifacts but no artifact storage config is set')
  }

  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const uploaded: AgentProviderOutputArtifact[] = []
  for (const artifact of artifacts) {
    const key = normalizeNonEmpty(artifact.key)
    if (!key) {
      uploaded.push(artifact)
      continue
    }
    const path = normalizeNonEmpty(artifact.path)
    if (!path) {
      throw new Error(`outputArtifact ${artifact.name} declares key ${key} but no path`)
    }
    const body = await readFile(path)
    await putS3Object({ config, key, body, fetch: fetchImpl, now: now() })
    uploaded.push({
      ...artifact,
      key: normalizeKey(key),
      url: `s3://${config.bucket}/${normalizeKey(key)}`,
    })
  }
  return uploaded
}
