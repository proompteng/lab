#!/usr/bin/env bun
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

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

const main = async () => {
  const endpointRaw = requireEnv('MINIO_ENDPOINT')
  const accessKey = requireEnv('MINIO_ACCESS_KEY')
  const secretKey = requireEnv('MINIO_SECRET_KEY')
  const bucket = (process.env.MINIO_BUCKET ?? process.env.ARTIFACT_BUCKET ?? 'agents-artifacts').trim()
  if (!bucket) {
    throw new Error('Missing MINIO_BUCKET')
  }

  const secure = parseBool(process.env.MINIO_SECURE) || endpointRaw.startsWith('https://')
  const endpoint = normalizeEndpoint(endpointRaw, secure)

  const client = new S3Client({
    endpoint,
    region: process.env.MINIO_REGION ?? 'us-east-1',
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  })

  const command = new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 })
  const url = await getSignedUrl(client, command, { expiresIn: 60 })
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
