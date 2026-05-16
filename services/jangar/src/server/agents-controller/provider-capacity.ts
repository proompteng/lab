import { asRecord, asString, readNested } from '~/server/primitives-http'
import type { KubernetesClient } from '~/server/primitives-kube'

import { extractJobFailureDetail } from './job-status'

export const PROVIDER_CAPACITY_EXHAUSTED_REASON = 'ProviderCapacityExhausted'
export const PROVIDER_AUTH_UNAVAILABLE_REASON = 'ProviderAuthUnavailable'

type FailureFallback = {
  reason: string
  message: string
}

const PROVIDER_CAPACITY_LOG_TAIL_LINES = 120
const PROVIDER_CAPACITY_PATTERNS = [
  /\byou(?:'|\u2019)?ve hit your usage limit\b/i,
  /\busage limit\b/i,
  /\binsufficient[_ -]?quota\b/i,
  /\bquota (?:has been )?exceeded\b/i,
  /\brate limit(?:ed)?\b/i,
  /\bresource has been exhausted\b/i,
]

const PROVIDER_AUTH_PATTERNS = [
  /\btoken_expired\b/i,
  /\binvalid_grant\b/i,
  /\bgrant not found\b/i,
  /\brefresh token (?:was already used|could not be refreshed|unavailable)\b/i,
  /\baccess token could not be refreshed\b/i,
  /\bprovided authentication token is expired\b/i,
  /\bmissing bearer or basic authentication\b/i,
  /\bchatgpt authentication required\b/i,
]

const MAX_PROVIDER_CAPACITY_MESSAGE_LENGTH = 320

const truncate = (value: string, limit: number) => {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

export const resolveProviderCapacityFailureFromText = (text: string) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const matchedLine = lines.find((line) => PROVIDER_CAPACITY_PATTERNS.some((pattern) => pattern.test(line)))
  if (!matchedLine) return null
  return {
    reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
    message: `provider capacity exhausted: ${truncate(matchedLine, MAX_PROVIDER_CAPACITY_MESSAGE_LENGTH)}`,
  }
}

export const resolveProviderAuthFailureFromText = (text: string) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const matchedLine = lines.find((line) => PROVIDER_AUTH_PATTERNS.some((pattern) => pattern.test(line)))
  if (!matchedLine) return null
  return {
    reason: PROVIDER_AUTH_UNAVAILABLE_REASON,
    message: `provider auth unavailable: ${truncate(matchedLine, MAX_PROVIDER_CAPACITY_MESSAGE_LENGTH)}`,
  }
}

const listJobPods = async (kube: Pick<KubernetesClient, 'list'>, namespace: string, jobName: string) => {
  const selectors = [`job-name=${jobName}`, `batch.kubernetes.io/job-name=${jobName}`]
  for (const selector of selectors) {
    try {
      const listed = await kube.list('pods', namespace, selector)
      const items = Array.isArray(listed.items) ? listed.items : []
      if (items.length > 0) {
        return items.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null)
      }
    } catch {
      // Keep the reconciler on the Kubernetes Job condition path if pod log access is unavailable.
    }
  }
  return []
}

const resolveContainerNames = (pod: Record<string, unknown>) => {
  const containers = readNested(pod, ['spec', 'containers'])
  if (!Array.isArray(containers)) return [null]
  const names = containers
    .map((container) => asString(asRecord(container)?.name))
    .filter((name): name is string => Boolean(name))
  return names.length > 0 ? names : [null]
}

export const extractProviderCapacityFailureFromJobLogs = async (
  kube: Pick<KubernetesClient, 'list' | 'logs'>,
  namespace: string,
  jobName: string,
) => {
  const pods = await listJobPods(kube, namespace, jobName)
  for (const pod of pods) {
    const podName = asString(readNested(pod, ['metadata', 'name']))
    if (!podName) continue
    for (const container of resolveContainerNames(pod)) {
      try {
        const logs = await kube.logs({
          pod: podName,
          namespace,
          container,
          tailLines: PROVIDER_CAPACITY_LOG_TAIL_LINES,
        })
        const providerAuthFailure = resolveProviderAuthFailureFromText(logs)
        if (providerAuthFailure) return providerAuthFailure
        const providerCapacityFailure = resolveProviderCapacityFailureFromText(logs)
        if (providerCapacityFailure) return providerCapacityFailure
      } catch {
        // Job conditions still carry the terminal failure when log reads are not permitted or no longer retained.
      }
    }
  }
  return null
}

export const extractProviderAwareJobFailure = async (
  kube: Pick<KubernetesClient, 'list' | 'logs'>,
  namespace: string,
  jobName: string,
  job: Record<string, unknown>,
  fallback: FailureFallback,
) =>
  (jobName ? await extractProviderCapacityFailureFromJobLogs(kube, namespace, jobName) : null) ??
  extractJobFailureDetail(job, fallback)

export const isNonRetryableProviderFailure = (reason: string) =>
  reason === PROVIDER_CAPACITY_EXHAUSTED_REASON || reason === PROVIDER_AUTH_UNAVAILABLE_REASON
