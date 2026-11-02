import { ArtifactStorageError, getS3ObjectTail } from '../artifact-storage'
import { RUNNER_LOG_SUFFIX } from '../runner-telemetry'

import type { KubernetesClient } from './kube-types'
import { asRecord, asString, readNested } from './primitives'
import type { AgentRunRecord } from './v1/agent-run-store'
import { readRunArtifactStorage } from './run-artifact-storage'

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
  const config = await readRunArtifactStorage(input.kube, input.namespace, secrets, env)
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
