import { asRecord, asString, readNested } from '../primitives'
import type { createKubernetesClient } from '../kube-types'
import {
  recordRuntimeDebrisDeletedPods,
  recordRuntimeDebrisDeleteErrors,
  recordRuntimeDebrisOrphanPods,
} from '../metrics'

import { logAgentsControllerInfo } from './operational-logging'
import type { RuntimeDebrisCleanupConfig, RuntimeDebrisCleanupMode } from './runtime-config'
import { resolveRuntimeDebrisCleanupConfig } from './runtime-config'

const AGENT_RUN_LABEL = 'agents.proompteng.ai/agent-run'
const RUNTIME_LABEL_SELECTOR = AGENT_RUN_LABEL
const TERMINAL_POD_PHASES = new Set(['Succeeded', 'Failed'])

type KubeClient = ReturnType<typeof createKubernetesClient>

type RuntimeDebrisCandidate = {
  name: string
  reason: 'missing_job_owner' | 'no_owner_reference'
}

export type RuntimeDebrisCleanupSummary = {
  deletedPods: number
  deleteErrors: number
  mode: RuntimeDebrisCleanupMode
  namespace: string
  orphanTerminalPods: number
  rateLimitedPods: number
  scannedPods: number
}

const listItems = (payload: Record<string, unknown>) => (Array.isArray(payload.items) ? payload.items : [])

const getMetadata = (resource: unknown) => asRecord(readNested(resource, ['metadata'])) ?? {}

const getPodName = (pod: unknown) => asString(readNested(pod, ['metadata', 'name']))?.trim() ?? null

const getPodPhase = (pod: unknown) => asString(readNested(pod, ['status', 'phase']))?.trim() ?? null

const getCreationTimestampMs = (pod: unknown) => {
  const raw = readNested(pod, ['metadata', 'creationTimestamp'])
  if (raw instanceof Date) return raw.getTime()
  const timestamp = asString(raw)
  if (!timestamp) return null
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

const getOwnerReferences = (pod: unknown) => {
  const ownerReferences = getMetadata(pod).ownerReferences
  return Array.isArray(ownerReferences) ? ownerReferences.map((entry) => asRecord(entry)).filter(Boolean) : []
}

const isDeleting = (pod: unknown) => Boolean(asString(readNested(pod, ['metadata', 'deletionTimestamp'])))

const getExistingJobNames = (jobs: unknown[]) =>
  new Set(
    jobs
      .map((job) => asString(readNested(job, ['metadata', 'name']))?.trim())
      .filter((name): name is string => Boolean(name)),
  )

const isStaleEnough = (pod: unknown, nowMs: number, retentionSeconds: number) => {
  const createdAtMs = getCreationTimestampMs(pod)
  if (createdAtMs === null) return false
  return nowMs - createdAtMs >= retentionSeconds * 1000
}

const selectRuntimeDebrisCandidate = (
  pod: unknown,
  existingJobNames: Set<string>,
  nowMs: number,
  retentionSeconds: number,
): RuntimeDebrisCandidate | null => {
  const name = getPodName(pod)
  if (!name) return null
  if (isDeleting(pod)) return null
  if (!TERMINAL_POD_PHASES.has(getPodPhase(pod) ?? '')) return null
  if (!isStaleEnough(pod, nowMs, retentionSeconds)) return null

  const ownerReferences = getOwnerReferences(pod)
  if (ownerReferences.length === 0) return { name, reason: 'no_owner_reference' }

  const jobOwners = ownerReferences.filter((owner) => asString(owner?.kind) === 'Job')
  if (jobOwners.some((owner) => existingJobNames.has(asString(owner?.name) ?? ''))) return null
  if (jobOwners.length > 0) return { name, reason: 'missing_job_owner' }

  return null
}

const recordRuntimeDebrisSummary = (summary: RuntimeDebrisCleanupSummary) => {
  const metricAttributes = { mode: summary.mode, namespace: summary.namespace }
  recordRuntimeDebrisOrphanPods(summary.orphanTerminalPods, metricAttributes)
  recordRuntimeDebrisDeletedPods(summary.deletedPods, metricAttributes)
  recordRuntimeDebrisDeleteErrors(summary.deleteErrors, metricAttributes)

  if (summary.orphanTerminalPods > 0 || summary.deletedPods > 0 || summary.deleteErrors > 0) {
    logAgentsControllerInfo('runtime_debris_reconcile_completed', {
      ...summary,
    })
  }
}

export const reconcileRuntimeDebris = async (input: {
  config?: RuntimeDebrisCleanupConfig
  kube: Pick<KubeClient, 'delete' | 'list'>
  namespace: string
  nowMs?: number
}): Promise<RuntimeDebrisCleanupSummary> => {
  const config = input.config ?? resolveRuntimeDebrisCleanupConfig()
  const summary: RuntimeDebrisCleanupSummary = {
    deletedPods: 0,
    deleteErrors: 0,
    mode: config.mode,
    namespace: input.namespace,
    orphanTerminalPods: 0,
    rateLimitedPods: 0,
    scannedPods: 0,
  }

  if (config.mode === 'disabled') return summary

  const [podList, jobList] = await Promise.all([
    input.kube.list('pods', input.namespace, RUNTIME_LABEL_SELECTOR),
    input.kube.list('jobs', input.namespace, RUNTIME_LABEL_SELECTOR),
  ])
  const pods = listItems(podList)
  const existingJobNames = getExistingJobNames(listItems(jobList))
  const nowMs = input.nowMs ?? Date.now()

  summary.scannedPods = pods.length
  const candidates = pods
    .map((pod) => selectRuntimeDebrisCandidate(pod, existingJobNames, nowMs, config.orphanPodRetentionSeconds))
    .filter((candidate): candidate is RuntimeDebrisCandidate => candidate !== null)

  summary.orphanTerminalPods = candidates.length
  if (config.mode !== 'delete') {
    recordRuntimeDebrisSummary(summary)
    return summary
  }

  const selected = candidates.slice(0, config.maxDeletesPerNamespace)
  summary.rateLimitedPods = Math.max(0, candidates.length - selected.length)

  for (const candidate of selected) {
    try {
      await input.kube.delete('pod', candidate.name, input.namespace, { wait: false })
      summary.deletedPods += 1
    } catch {
      summary.deleteErrors += 1
    }
  }

  recordRuntimeDebrisSummary(summary)

  return summary
}
