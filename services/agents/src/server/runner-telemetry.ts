import { parseRunnerTelemetry, RUNNER_TELEMETRY_KEY, RUNNER_TELEMETRY_LABEL } from '../runner-telemetry'

import type { KubernetesClient } from './kube-types'
import { asRecord, asString, readNested } from './primitives'

export const withRunnerTelemetry = async (
  kube: KubernetesClient,
  resource: Record<string, unknown>,
  namespace: string,
) => {
  if (readNested(resource, ['spec', 'runtime', 'type']) !== 'job') return resource
  const status = asRecord(resource.status) ?? {}
  if (['Succeeded', 'Failed', 'Cancelled'].includes(asString(status.phase) ?? '')) return resource
  const metadata = asRecord(resource.metadata) ?? {}
  const name = asString(metadata.name)
  const uid = asString(metadata.uid)
  if (!name || !uid) return resource
  const maps = await kube.list(
    'configmaps',
    namespace,
    `${RUNNER_TELEMETRY_LABEL}=true,agents.proompteng.ai/agent-run=${name}`,
  )
  const snapshots = []
  for (const value of Array.isArray(maps.items) ? maps.items : []) {
    const map = asRecord(value) ?? {}
    const owners = readNested(map, ['metadata', 'ownerReferences'])
    if (!Array.isArray(owners) || !owners.some((owner) => asRecord(owner)?.uid === uid)) continue
    const raw = asString(readNested(map, ['data', RUNNER_TELEMETRY_KEY]))
    if (!raw || raw === 'null') continue
    const snapshot = parseRunnerTelemetry(JSON.parse(raw))
    if (!snapshot) throw new Error('runner telemetry snapshot is invalid')
    snapshots.push(snapshot)
  }
  const telemetry = snapshots.sort((a, b) => b.heartbeatAt.localeCompare(a.heartbeatAt))[0]
  if (!telemetry) return resource
  return { ...resource, status: { ...status, runner: { ...asRecord(status.runner), telemetry } } }
}
