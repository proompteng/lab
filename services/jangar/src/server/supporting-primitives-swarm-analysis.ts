import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { hashNameSuffix, makeHashedName } from '~/server/supporting-primitives-naming'
import {
  deriveStageStaggerMinute,
  type StageName,
  STAGE_CADENCE_KEY,
  STAGE_LAST_RUN_KEY,
  type StageTargetRef,
  SWARM_REQUIREMENT_SCOPE_FIELD_LIMIT,
} from '~/server/supporting-primitives-swarm-config'

export const TERMINAL_SUCCESS_PHASES = new Set(['succeeded', 'success', 'completed'])
export const TERMINAL_FAILURE_PHASES = new Set(['failed', 'error', 'cancelled'])
export const ACTIVE_PHASES = new Set(['pending', 'running', 'inprogress', 'progressing', 'queued'])

export const parseDurationToMs = (raw: string) => {
  const value = raw.trim().toLowerCase()
  const match = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(
    value,
  )
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = match[2]
  if (unit.startsWith('s')) return amount * 1000
  if (unit.startsWith('m')) return amount * 60 * 1000
  if (unit.startsWith('h')) return amount * 60 * 60 * 1000
  return amount * 24 * 60 * 60 * 1000
}

export const cadenceToCron = (raw: string, options?: { swarmName?: string; stage?: StageName }) => {
  const durationMs = parseDurationToMs(raw)
  if (!durationMs) return null
  const durationMinutes = durationMs / (60 * 1000)
  if (durationMinutes < 1) return null
  if (durationMinutes < 60 && Number.isInteger(durationMinutes)) {
    return `*/${durationMinutes} * * * *`
  }
  if (durationMinutes % 60 === 0) {
    const hours = durationMinutes / 60
    if (hours >= 1 && hours <= 23 && Number.isInteger(hours)) {
      if (options?.swarmName && options?.stage) {
        const minute = deriveStageStaggerMinute(options.swarmName, options.stage)
        if (hours === 1) return `${minute} * * * *`
        return `${minute} */${hours} * * *`
      }
      return `0 */${hours} * * *`
    }
  }
  if (durationMinutes % (24 * 60) === 0) {
    const days = durationMinutes / (24 * 60)
    if (days >= 1 && days <= 28 && Number.isInteger(days)) {
      return `0 0 */${days} * *`
    }
  }
  return null
}

export const collectStaleStageSignals = (
  stageConfigs: Array<{ stage: StageName; enabled: boolean; every?: string }>,
  status: Record<string, unknown>,
  runs: Record<string, unknown>[],
  nowMs: number,
  options?: { ignoreBeforeMs?: number | null },
) => {
  const ignoreBeforeMs = options?.ignoreBeforeMs ?? null
  const staleSignals = []
  for (const stageConfig of stageConfigs) {
    if (!stageConfig.enabled || !stageConfig.every) continue
    const cadenceMs = parseDurationToMs(stageConfig.every)
    if (cadenceMs === null || cadenceMs <= 0) continue
    const stageRuns = runs.filter(
      (run) => asString(readNested(run, ['metadata', 'labels', 'swarm.proompteng.ai/stage'])) === stageConfig.stage,
    )
    const latestRunTime = sortByMostRecentRun(stageRuns).at(0)
    const fromRuns = parseTimeOrNull(getRunTimestamp(latestRunTime ?? {}))
    const fromStatus = parseTimeOrNull(asString(readNested(status, [STAGE_LAST_RUN_KEY[stageConfig.stage]]) ?? null))
    const lastRunMs = [fromRuns, fromStatus]
      .filter((value): value is number => value !== null)
      .reduce((left, right) => Math.max(left, right), Number.NEGATIVE_INFINITY)
    if (!Number.isFinite(lastRunMs) || lastRunMs <= 0) continue
    if (ignoreBeforeMs !== null && lastRunMs <= ignoreBeforeMs) continue
    const ageMs = nowMs - lastRunMs
    const maxAgeMs = 2 * cadenceMs
    if (ageMs <= maxAgeMs) continue
    staleSignals.push({
      stage: stageConfig.stage,
      lastRunAt: new Date(lastRunMs).toISOString(),
      ageMs,
      configuredEveryMs: cadenceMs,
      configuredEvery: stageConfig.every,
      staleAfterMs: maxAgeMs,
    })
  }
  return staleSignals
}

export const resolveStageEvery = (
  spec: Record<string, unknown>,
  stageSpec: Record<string, unknown>,
  stage: StageName,
) => {
  const stageEvery = asString(stageSpec.every)
  if (stageEvery) return stageEvery
  const cadence = asRecord(spec.cadence) ?? {}
  return asString(cadence[STAGE_CADENCE_KEY[stage]])
}

export const resolveStageTargetRef = (stageSpec: Record<string, unknown>, defaultNamespace: string) => {
  const targetRef = asRecord(stageSpec.targetRef) ?? {}
  const kind = asString(targetRef.kind)
  const name = asString(targetRef.name)
  const namespace = asString(targetRef.namespace) ?? defaultNamespace
  if (!kind || !name) return null
  if (kind !== 'AgentRun' && kind !== 'OrchestrationRun') return null
  return { kind, name, namespace } satisfies StageTargetRef
}

export const resolveStageApiVersion = (kind: string) => {
  if (kind === 'AgentRun') return 'agents.proompteng.ai/v1alpha1'
  if (kind === 'OrchestrationRun') return 'orchestration.proompteng.ai/v1alpha1'
  return ''
}

export const stageScheduleName = (swarmName: string, stage: StageName) => makeHashedName(swarmName, `${stage}-sched`)

export const getRunTimestamp = (resource: Record<string, unknown>) => {
  return (
    asString(readNested(resource, ['status', 'startedAt'])) ??
    asString(readNested(resource, ['status', 'finishedAt'])) ??
    asString(readNested(resource, ['metadata', 'creationTimestamp']))
  )
}

export const parseTimeOrNull = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

export const sortByMostRecentRun = (resources: Record<string, unknown>[]) => {
  return [...resources].sort((left, right) => {
    const leftTs = parseTimeOrNull(getRunTimestamp(left))
    const rightTs = parseTimeOrNull(getRunTimestamp(right))
    if (leftTs === null && rightTs === null) return 0
    if (leftTs === null) return 1
    if (rightTs === null) return -1
    return rightTs - leftTs
  })
}

export const isIdempotencyDuplicateRun = (resource: Record<string, unknown>) => {
  const rawConditions = readNested(resource, ['status', 'conditions'])
  const conditions = Array.isArray(rawConditions) ? rawConditions : []
  if (conditions.length === 0) return false
  return conditions.some((condition) => {
    const record = asRecord(condition)
    if (!record) return false
    const reason = (asString(record.reason) ?? '').toLowerCase()
    const type = (asString(record.type) ?? '').toLowerCase()
    return reason === 'idempotencykeyinuse' || type === 'duplicate'
  })
}

export const countConsecutiveFailures = (resources: Record<string, unknown>[]) => {
  const sorted = sortByMostRecentRun(resources)
  let failures = 0
  for (const resource of sorted) {
    if (isIdempotencyDuplicateRun(resource)) continue
    const phase = (asString(readNested(resource, ['status', 'phase'])) ?? '').toLowerCase()
    if (!phase) continue
    if (TERMINAL_FAILURE_PHASES.has(phase)) {
      failures += 1
      continue
    }
    if (TERMINAL_SUCCESS_PHASES.has(phase) || ACTIVE_PHASES.has(phase)) break
  }
  return failures
}

export const countIdempotencyDuplicates = (resources: Record<string, unknown>[]) => {
  return resources.filter((resource) => isIdempotencyDuplicateRun(resource)).length
}

export const resolveLatestSuccessfulRunTime = (resources: Record<string, unknown>[]) => {
  const latestSuccessful = sortByMostRecentRun(resources).find((resource) =>
    TERMINAL_SUCCESS_PHASES.has((asString(readNested(resource, ['status', 'phase'])) ?? '').toLowerCase()),
  )
  return latestSuccessful ? parseTimeOrNull(getRunTimestamp(latestSuccessful)) : null
}

export const collectRecentFailureRuns = (resources: Record<string, unknown>[], limit = 5) => {
  const sorted = sortByMostRecentRun(resources)
  const failures = sorted
    .filter((resource) => {
      if (isIdempotencyDuplicateRun(resource)) return false
      const phase = (asString(readNested(resource, ['status', 'phase'])) ?? '').toLowerCase()
      return TERMINAL_FAILURE_PHASES.has(phase)
    })
    .slice(0, limit)
  return failures.map((resource) => {
    const failedCondition = (
      Array.isArray(readNested(resource, ['status', 'conditions']))
        ? (readNested(resource, ['status', 'conditions']) as unknown[])
        : []
    )
      .map((entry) => asRecord(entry))
      .find((condition) => asString(condition?.type) === 'Failed' && asString(condition?.status) === 'True')
    const failedStep = (
      Array.isArray(readNested(resource, ['status', 'workflow', 'steps']))
        ? (readNested(resource, ['status', 'workflow', 'steps']) as unknown[])
        : []
    )
      .map((entry) => asRecord(entry))
      .find((step) => asString(step?.phase) === 'Failed')
    const reason =
      asString(readNested(resource, ['status', 'message'])) ??
      asString(readNested(resource, ['status', 'reason'])) ??
      asString(failedCondition?.message) ??
      asString(failedCondition?.reason) ??
      asString(failedStep?.message)
    return {
      name: asString(readNested(resource, ['metadata', 'name'])) ?? 'unknown',
      namespace: asString(readNested(resource, ['metadata', 'namespace'])) ?? '',
      phase: (asString(readNested(resource, ['status', 'phase'])) ?? '').toLowerCase(),
      timestamp: getRunTimestamp(resource),
      conclusion: asString(readNested(resource, ['status', 'conclusion'])) || null,
      reason: reason || null,
    }
  })
}

export const filterRunsAfterTime = (resources: Record<string, unknown>[], timestampMs: number | null) => {
  if (timestampMs === null) return resources
  return resources.filter((resource) => {
    const runTimestamp = parseTimeOrNull(getRunTimestamp(resource))
    return runTimestamp !== null && runTimestamp > timestampMs
  })
}

export const requirementIdForSignal = (signalNamespace: string, signalName: string) =>
  hashNameSuffix(`${signalNamespace}/${signalName}`)

export const isHulyChannel = (channel: string | null | undefined) => {
  if (!channel) return false
  const value = channel.trim()
  if (!value) return false
  if (value.toLowerCase().startsWith('huly://')) return true
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase().includes('huly')
  } catch {
    return false
  }
}

export const stringifyUnknown = (value: unknown) => {
  if (typeof value === 'string') return value
  try {
    const result = JSON.stringify(value)
    return result === undefined ? '' : result
  } catch {
    return ''
  }
}

const truncateUtf8 = (value: string, maxBytes: number) => {
  const safeMaxBytes = Math.max(0, maxBytes)
  if (!value || safeMaxBytes === 0) return ''
  let usedBytes = 0
  const encoder = new TextEncoder()
  let result = ''
  for (const char of value) {
    const charBytes = encoder.encode(char).byteLength
    if (usedBytes + charBytes > safeMaxBytes) break
    usedBytes += charBytes
    result += char
  }
  return result
}

export const clampUtf8 = (value: string, maxBytes: number) => {
  const encoder = new TextEncoder()
  const encoded = encoder.encode(value)
  if (encoded.byteLength <= maxBytes) {
    return {
      value,
      bytes: encoded.byteLength,
      truncated: false,
    }
  }
  return {
    value: truncateUtf8(value, maxBytes),
    bytes: encoded.byteLength,
    truncated: true,
  }
}

const extractPayloadObjectiveObject = (payload: Record<string, unknown>) => {
  const fields: Array<unknown> = [payload.objective, payload.scope, payload.goal, payload.summary]
  for (const value of fields) {
    if (typeof value === 'string') {
      const normalized = value.trim()
      if (normalized.length > 0) return normalized
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
  }
  return ''
}

const extractPayloadObjective = (payload: string) => {
  try {
    const parsed = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ''
    }
    const objectiveValue = parsed.objective
    if (typeof objectiveValue === 'string') {
      const normalized = objectiveValue.trim()
      if (normalized.length > 0) return normalized
    }
    const acceptanceValue = parsed.acceptance
    if (typeof acceptanceValue === 'string') {
      const normalized = acceptanceValue.trim()
      if (normalized.length > 0) return `acceptance: ${normalized}`
    }
    if (Array.isArray(acceptanceValue)) {
      const acceptanceList = acceptanceValue
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0)
      if (acceptanceList.length > 0) return `acceptance: ${acceptanceList.join(', ')}`
    }
    const missionValue = parsed.mission
    if (typeof missionValue === 'string') {
      const normalized = missionValue.trim()
      if (normalized.length > 0) return `mission: ${normalized}`
    }
    const objectiveSource = extractPayloadObjectiveObject(parsed as Record<string, unknown>)
    if (objectiveSource) return objectiveSource
  } catch {
    // ignore malformed payloads
  }
  return ''
}

export const makeRequirementObjective = (description: string, payload: string) => {
  const payloadObjective = payload ? extractPayloadObjective(payload) : ''
  const objectiveSource = payloadObjective || payload
  const parts = [description, objectiveSource].filter((value) => value.length > 0)
  if (parts.length === 0) return ''
  const combined = parts.join('\n\n')
  return clampUtf8(combined, SWARM_REQUIREMENT_SCOPE_FIELD_LIMIT).value
}

export const normalizeParameterMap = (raw: unknown) => {
  const record = asRecord(raw) ?? {}
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      output[key] = value
      continue
    }
    if (value === null || value === undefined) continue
    output[key] = stringifyUnknown(value)
  }
  return output
}

export const makeGenerateName = (base: string, suffix: string) => {
  const candidate = makeHashedName(base, suffix)
  const trimmed = candidate.slice(0, 62).replace(/-+$/, '')
  return `${trimmed || 'run'}-`
}

export const resolveStageTargetResource = async (
  kube: ReturnType<typeof createKubernetesClient>,
  targetRef: StageTargetRef,
) => {
  if (targetRef.kind === 'AgentRun') {
    return kube.get(RESOURCE_MAP.AgentRun, targetRef.name, targetRef.namespace)
  }
  return kube.get(RESOURCE_MAP.OrchestrationRun, targetRef.name, targetRef.namespace)
}
