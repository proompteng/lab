import { ArtifactStorageError, getS3ObjectTail } from '../artifact-storage'
import { parseRunnerTelemetry, runnerTelemetryKey } from '../runner-telemetry'

import type { KubernetesClient } from './kube-types'
import { asRecord, asString, readNested } from './primitives'
import { hasRunArtifactStorage, readRunArtifactStorage } from './run-artifact-storage'

export const withRunnerTelemetry = async (
  kube: Pick<KubernetesClient, 'get'>,
  resource: Record<string, unknown>,
  namespace: string,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
) => {
  if (readNested(resource, ['spec', 'runtime', 'type']) !== 'job') return resource
  const status = asRecord(resource.status) ?? {}
  if (['Succeeded', 'Failed', 'Cancelled'].includes(asString(status.phase) ?? '')) return resource
  const uid = asString(readNested(resource, ['metadata', 'uid']))
  const secrets = readNested(resource, ['spec', 'secrets'])
  if (!uid || !hasRunArtifactStorage(secrets)) return resource
  const config = await readRunArtifactStorage(kube, namespace, secrets, options.env ?? process.env)
  const tail = await getS3ObjectTail({
    config,
    key: runnerTelemetryKey(namespace, uid),
    fetch: options.fetch ?? fetch,
    now: new Date(),
    maxBytes: 32768,
  }).catch((error: unknown) => {
    if (error instanceof ArtifactStorageError && error.status === 404) return null
    throw error
  })
  if (!tail) return resource
  if (tail.truncated) throw new Error('runner telemetry exceeds its byte budget')
  const telemetry = parseRunnerTelemetry(JSON.parse(tail.text))
  if (!telemetry) throw new Error('runner telemetry snapshot is invalid')
  return { ...resource, status: { ...status, runner: { ...asRecord(status.runner), telemetry } } }
}
