import { parseRunnerTelemetry, type RunnerTelemetry } from '../../runner-telemetry'
import { asRecord, asString, readNested } from '../primitives'
import type { KubernetesClient } from '../kube-types'
import { AGENT_RUNNER_RESULT_PREVIEW_CHARS, type AgentRunnerResultPreview } from '../../runner-result'
import {
  RUNNER_STATUS_EVENT,
  RUNNER_STATUS_LOG_BYTES,
  runnerStatusDigest,
  runnerStatusReferenceSchema,
} from '../../runner-status'

export type RunnerTerminalPhase = 'succeeded' | 'failed' | 'cancelled'

export type RunnerTerminalStatus = {
  status: RunnerTerminalPhase
  provider?: string
  adapter?: string
  binary?: string
  exitCode?: number
  signal?: string | null
  startedAt?: string
  finishedAt?: string
  threadId?: string
  turnId?: string
  model?: string
  effort?: string
  cwd?: string | null
  artifacts?: {
    statusPath?: string
    logPath?: string
    outputArtifacts?: Record<string, unknown>[]
  }
  error?: string
  result?: AgentRunnerResultPreview
  telemetry?: RunnerTelemetry
}

export type RunnerTerminalOutcome = {
  phase: 'Succeeded' | 'Failed' | 'Cancelled'
  reason: 'Completed' | 'RunnerFailed' | 'RunnerCancelled'
  message?: string
  conditionType: 'Succeeded' | 'Failed' | 'Cancelled'
}

const RUNNER_STATUS_VALUES = new Set<RunnerTerminalPhase>(['succeeded', 'failed', 'cancelled'])
const RUNNER_MESSAGE_MAX_LENGTH = 640

const truncate = (value: string, limit = RUNNER_MESSAGE_MAX_LENGTH) => {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

const asFiniteNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const normalizeNullableString = (value: unknown) => {
  if (value == null) return value === null ? null : undefined
  return asString(value) ?? undefined
}

const normalizeArtifacts = (value: unknown): RunnerTerminalStatus['artifacts'] | undefined => {
  const artifacts = asRecord(value)
  if (!artifacts) return undefined
  const outputArtifacts = Array.isArray(artifacts.outputArtifacts)
    ? artifacts.outputArtifacts.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => !!item)
    : undefined
  const statusPath = asString(artifacts.statusPath)
  const logPath = asString(artifacts.logPath)
  if (!statusPath && !logPath && !outputArtifacts?.length) return undefined
  return {
    ...(statusPath ? { statusPath } : {}),
    ...(logPath ? { logPath } : {}),
    ...(outputArtifacts?.length ? { outputArtifacts } : {}),
  }
}

export const parseRunnerTerminalStatus = (value: unknown): RunnerTerminalStatus | null => {
  const record = asRecord(value)
  if (!record) return null
  const status = asString(record.status)
  if (!status || !RUNNER_STATUS_VALUES.has(status as RunnerTerminalPhase)) return null
  const telemetry = record.telemetry === undefined ? null : parseRunnerTelemetry(record.telemetry)
  if (record.telemetry !== undefined && !telemetry) return null
  const artifacts = normalizeArtifacts(record.artifacts)
  const rawResult = asRecord(record.result)
  const resultText = asString(rawResult?.text)
  if (record.result !== undefined && (!rawResult || resultText === null || typeof rawResult.truncated !== 'boolean'))
    return null
  const result =
    rawResult && resultText !== null
      ? {
          text: resultText.slice(0, AGENT_RUNNER_RESULT_PREVIEW_CHARS),
          truncated: rawResult.truncated === true || resultText.length > AGENT_RUNNER_RESULT_PREVIEW_CHARS,
        }
      : undefined
  return {
    status: status as RunnerTerminalPhase,
    ...(telemetry ? { telemetry } : {}),
    ...(asString(record.provider) ? { provider: asString(record.provider) as string } : {}),
    ...(asString(record.adapter) ? { adapter: asString(record.adapter) as string } : {}),
    ...(asString(record.binary) ? { binary: asString(record.binary) as string } : {}),
    ...(asFiniteNumber(record.exitCode) !== undefined ? { exitCode: asFiniteNumber(record.exitCode) } : {}),
    ...(normalizeNullableString(record.signal) !== undefined ? { signal: normalizeNullableString(record.signal) } : {}),
    ...(asString(record.startedAt) ? { startedAt: asString(record.startedAt) as string } : {}),
    ...(asString(record.finishedAt) ? { finishedAt: asString(record.finishedAt) as string } : {}),
    ...(asString(record.threadId) ? { threadId: asString(record.threadId) as string } : {}),
    ...(asString(record.turnId) ? { turnId: asString(record.turnId) as string } : {}),
    ...(asString(record.model) ? { model: asString(record.model) as string } : {}),
    ...(asString(record.effort) ? { effort: asString(record.effort) as string } : {}),
    ...(normalizeNullableString(record.cwd) !== undefined ? { cwd: normalizeNullableString(record.cwd) } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(result ? { result } : {}),
    ...(asString(record.error) ? { error: truncate(asString(record.error) as string) } : {}),
  }
}

const parseTerminationMessage = (message: unknown) => {
  const raw = asString(message)
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value: unknown = JSON.parse(trimmed)
    const reference = runnerStatusReferenceSchema.safeParse(value)
    return reference.success ? reference.data : parseRunnerTerminalStatus(value)
  } catch {
    return null
  }
}

const podStartTimeMs = (pod: Record<string, unknown>) => {
  const startedAt = asString(readNested(pod, ['status', 'startTime']))
  if (!startedAt) return 0
  const parsed = Date.parse(startedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

const listJobPods = async (kube: Pick<KubernetesClient, 'list'>, namespace: string, jobName: string) => {
  const selectors = [`job-name=${jobName}`, `batch.kubernetes.io/job-name=${jobName}`]
  for (const selector of selectors) {
    try {
      const listed = await kube.list('pods', namespace, selector)
      const items = Array.isArray(listed.items) ? listed.items : []
      if (items.length > 0) {
        return items
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
          .sort((left, right) => podStartTimeMs(right) - podStartTimeMs(left))
      }
    } catch {
      // The Job condition path still works when pod reads are unavailable.
    }
  }
  return []
}

const collectPodRunnerStatuses = async (
  pod: Record<string, unknown>,
  kube: Pick<KubernetesClient, 'logs'>,
  namespace: string,
) => {
  const rawStatuses = [
    ...(Array.isArray(readNested(pod, ['status', 'containerStatuses']))
      ? (readNested(pod, ['status', 'containerStatuses']) as unknown[])
      : []),
    ...(Array.isArray(readNested(pod, ['status', 'initContainerStatuses']))
      ? (readNested(pod, ['status', 'initContainerStatuses']) as unknown[])
      : []),
  ]
  const containers = rawStatuses
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .sort(
      (left, right) =>
        (asString(right.name) === 'agent-runner' ? 1 : 0) - (asString(left.name) === 'agent-runner' ? 1 : 0),
    )
  const statuses: RunnerTerminalStatus[] = []
  for (const container of containers) {
    for (const state of ['state', 'lastState']) {
      const message = parseTerminationMessage(readNested(container, [state, 'terminated', 'message']))
      if (!message) continue
      if (!('runnerStatusDigest' in message)) {
        statuses.push(message)
        continue
      }
      const podName = asString(readNested(pod, ['metadata', 'name']))
      const containerName = asString(container.name)
      if (!podName || !containerName) throw new Error('runner status reference has no Pod/container identity')
      const logs = await kube.logs({
        pod: podName,
        namespace,
        container: containerName,
        tailLines: 100,
        limitBytes: RUNNER_STATUS_LOG_BYTES,
      })
      let resolved: RunnerTerminalStatus | null = null
      for (const line of logs.trimEnd().split('\n').reverse()) {
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        const event = asRecord(readNested(value, ['event']))
        const status = asRecord(event?.status)
        if (event?.type !== RUNNER_STATUS_EVENT || !status || runnerStatusDigest(status) !== message.runnerStatusDigest)
          continue
        resolved = parseRunnerTerminalStatus(status)
        if (resolved) break
      }
      if (!resolved) throw new Error('runner status log reference could not be resolved')
      statuses.push(resolved)
    }
  }
  return statuses
}

export const extractRunnerStatusFromJobPods = async (
  kube: Pick<KubernetesClient, 'list' | 'logs'>,
  namespace: string,
  jobName: string,
  preferredStatuses: RunnerTerminalPhase[] = [],
) => {
  const candidates: RunnerTerminalStatus[] = []
  for (const pod of await listJobPods(kube, namespace, jobName)) {
    candidates.push(...(await collectPodRunnerStatuses(pod, kube, namespace)))
  }
  for (const preferred of preferredStatuses) {
    const match = candidates.find((candidate) => candidate.status === preferred)
    if (match) return match
  }
  return candidates[0] ?? null
}

export const runnerStatusToTerminalOutcome = (status: RunnerTerminalStatus): RunnerTerminalOutcome => {
  if (status.status === 'succeeded') {
    return { phase: 'Succeeded', reason: 'Completed', conditionType: 'Succeeded' }
  }
  if (status.status === 'cancelled') {
    return {
      phase: 'Cancelled',
      reason: 'RunnerCancelled',
      message: status.error ? truncate(status.error) : 'agent runner cancelled',
      conditionType: 'Cancelled',
    }
  }
  return {
    phase: 'Failed',
    reason: 'RunnerFailed',
    message: status.error ? truncate(status.error) : 'agent runner failed',
    conditionType: 'Failed',
  }
}

export const runnerStatusForAgentRunStatus = (status: RunnerTerminalStatus): Record<string, unknown> => ({
  status: status.status,
  ...(status.telemetry ? { telemetry: status.telemetry } : {}),
  ...(status.provider ? { provider: status.provider } : {}),
  ...(status.adapter ? { adapter: status.adapter } : {}),
  ...(status.binary ? { binary: status.binary } : {}),
  ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
  ...(status.signal !== undefined ? { signal: status.signal } : {}),
  ...(status.startedAt ? { startedAt: status.startedAt } : {}),
  ...(status.finishedAt ? { finishedAt: status.finishedAt } : {}),
  ...(status.threadId ? { threadId: status.threadId } : {}),
  ...(status.turnId ? { turnId: status.turnId } : {}),
  ...(status.model ? { model: status.model } : {}),
  ...(status.effort ? { effort: status.effort } : {}),
  ...(status.cwd !== undefined ? { cwd: status.cwd } : {}),
  ...(status.artifacts ? { artifacts: status.artifacts } : {}),
  ...(status.error ? { error: status.error } : {}),
  ...(status.result ? { result: status.result } : {}),
})

export const runnerStatusOutputArtifacts = (status: RunnerTerminalStatus) => status.artifacts?.outputArtifacts ?? []

const artifactKey = (artifact: Record<string, unknown>) =>
  [artifact.name, artifact.path, artifact.key, artifact.url].map((value) => String(value ?? '')).join('\u0000')

export const mergeAgentRunArtifacts = (existing: unknown, incoming: Record<string, unknown>[]) => {
  const base = Array.isArray(existing)
    ? existing.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => !!item)
    : []
  const seen = new Set(base.map(artifactKey))
  const merged = [...base]
  for (const artifact of incoming) {
    const key = artifactKey(artifact)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(artifact)
  }
  return merged
}
