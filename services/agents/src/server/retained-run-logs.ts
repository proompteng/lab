import { ArtifactStorageError, getS3ObjectTail, resolveArtifactUploadConfig } from '../artifact-storage'
import { RUNNER_LOG_SUFFIX } from '../runner-telemetry'

import type { KubernetesClient } from './kube-types'
import { asRecord, asString, readNested } from './primitives'
import type { AgentRunRecord } from './v1/agent-run-store'

export class RetainedRunLogsNotFound extends Error {}

export const readRetainedRunLogs = async (input: {
  record: AgentRunRecord
  namespace: string
  kube: KubernetesClient
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  tailLines: number | null
  pod: string | null
  container: string | null
}) => {
  const resource = asRecord(input.record.payload.resource) ?? {}
  const namespace =
    asString(readNested(resource, ['metadata', 'namespace'])) ??
    asString(readNested(input.record.payload, ['request', 'namespace']))
  if (namespace !== input.namespace) throw new RetainedRunLogsNotFound('run logs not found in this namespace')
  const podName = asString(readNested(resource, ['status', 'runner', 'telemetry', 'podName']))
  if (input.pod && input.pod !== podName) throw new RetainedRunLogsNotFound('retained pod logs not found')
  if (input.container && input.container !== 'agent-runner')
    throw new RetainedRunLogsNotFound('retained container logs not found')
  const values = readNested(resource, ['status', 'artifacts'])
  const artifacts = Array.isArray(values) ? values : []
  const env = input.env ?? process.env
  const bucket = env.AGENTS_ARTIFACTS_BUCKET
  const observed = artifacts.map(asRecord).find((item) => item?.name === 'runner-log' && typeof item.url === 'string')
  const result = artifacts.map(asRecord).find((item) => item?.name === 'runner-result' && typeof item.key === 'string')
  const artifact =
    observed ??
    (result && bucket ? { name: 'runner-log', url: `s3://${bucket}/${result.key}${RUNNER_LOG_SUFFIX}` } : null)
  if (!artifact) throw new RetainedRunLogsNotFound('no live or retained runner logs are available')
  const reference = new URL(asString(artifact.url) ?? '')
  if (
    reference.protocol !== 's3:' ||
    !bucket ||
    reference.hostname !== bucket ||
    reference.search ||
    reference.hash ||
    reference.username ||
    reference.password ||
    reference.port
  ) {
    throw new Error('retained log artifact does not match the configured storage bucket')
  }
  const secrets = readNested(input.record.payload, ['request', 'secrets']) ?? readNested(resource, ['spec', 'secrets'])
  if (!Array.isArray(secrets) || !secrets.includes('agents-artifacts'))
    throw new Error('run did not authorize artifact storage')
  const secret = await input.kube.get('secret', 'agents-artifacts', input.namespace)
  const data = asRecord(secret?.data) ?? {}
  const access = asString(data.AWS_ACCESS_KEY_ID)
  const secretKey = asString(data.AWS_SECRET_ACCESS_KEY)
  if (!access || !secretKey) throw new Error('artifact storage credentials are unavailable')
  const storageEnv = {
    AGENTS_ARTIFACTS_ENDPOINT: env.AGENTS_ARTIFACTS_ENDPOINT,
    AGENTS_ARTIFACTS_BUCKET: bucket,
    AGENTS_ARTIFACTS_REGION: env.AGENTS_ARTIFACTS_REGION,
    AGENTS_ARTIFACTS_ACCESS_KEY_ID: Buffer.from(access, 'base64').toString('utf8'),
    AGENTS_ARTIFACTS_SECRET_ACCESS_KEY: Buffer.from(secretKey, 'base64').toString('utf8'),
  }
  const config = resolveArtifactUploadConfig(storageEnv)
  if (!config) throw new Error('artifact storage is not configured')
  const key = decodeURIComponent(reference.pathname.slice(1))
  if (!key || key.split('/').some((part) => part === '.' || part === '..'))
    throw new Error('invalid retained log object key')
  const tail = await getS3ObjectTail({ config, key, fetch: input.fetch ?? fetch, now: new Date() }).catch(
    (error: unknown) => {
      if (error instanceof ArtifactStorageError && error.status === 404)
        throw new RetainedRunLogsNotFound('retained log artifact is unavailable')
      throw error
    },
  )
  const all = tail.text.trimEnd().split('\n')
  const limit = input.tailLines ?? 5000
  const lines = all.slice(-limit)
  return {
    logs: `${lines.join('\n')}\n`,
    artifact,
    truncated: tail.truncated || all.length > limit,
    pod: podName,
  }
}
