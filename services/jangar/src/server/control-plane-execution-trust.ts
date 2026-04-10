import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import { createKubeGateway, type KubeGateway } from '~/server/kube-gateway'
import { asRecord, asString } from '~/server/primitives-http'
import type { ExecutionTrustStage, ExecutionTrustStatus, ExecutionTrustSwarm } from '~/data/agents-control-plane'

const DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT = 20
const SWARM_STAGE_NAMES = ['discover', 'plan', 'implement', 'verify'] as const
const SWARM_REQUIREMENTS_PENDING_STALE_THRESHOLD_MS = 45 * 60 * 1000

const SWARM_STAGE_LAST_RUN_KEY: Record<(typeof SWARM_STAGE_NAMES)[number], string> = {
  discover: 'lastDiscoverAt',
  plan: 'lastPlanAt',
  implement: 'lastImplementAt',
  verify: 'lastVerifyAt',
}

type ExecutionTrustBlock = {
  type: ExecutionTrustStatus['blocking_windows'][number]['type']
  scope: string
  name?: string
  reason: string
  class: ExecutionTrustStatus['blocking_windows'][number]['class']
}

export type ExecutionTrustSnapshot = {
  executionTrust: ExecutionTrustStatus
  swarms: ExecutionTrustSwarm[]
  stages: ExecutionTrustStage[]
}

export type ExecutionTrustInput = {
  namespace: string
  now: Date
  swarms: string[]
  kube?: KubeGateway
  summaryLimit?: number
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const uniqueStrings = <T extends string>(values: readonly T[]) => {
  const seen = new Set<T>()
  const unique: T[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

const toIso = (value: number | null) => (value === null ? null : new Date(value).toISOString())

const parseDateMs = (value: unknown) => {
  const parsed = asString(value)
  if (!parsed) return null
  const millis = Date.parse(parsed)
  return Number.isFinite(millis) ? millis : null
}

const parseDurationToMs = (value: string | null) => {
  const normalized = (value ?? '').trim().toLowerCase()
  const match = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(
    normalized,
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

const resolveExecutionTrustSwarms = () => resolveControlPlaneStatusConfig(process.env).executionTrustSwarms

export const resolveExecutionTrustSummaryLimit = () =>
  resolveControlPlaneStatusConfig(process.env).executionTrustSummaryLimit

const asExecutionTrustClass = (value: unknown): 'degraded' | 'blocked' | 'unknown' =>
  value === 'degraded' || value === 'blocked' || value === 'unknown' ? value : 'unknown'

const readRequirementsPending = (raw: unknown): number => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw))
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  }
  return 0
}

const evaluateRequirementsPendingClass = (input: {
  pending: number
  latestRequirementTimestampMs: number | null
  nowMs: number
  frozen: boolean
}): ExecutionTrustSwarm['requirements_pending_class'] => {
  if (input.frozen) return 'blocked'
  if (input.pending <= 0) return 'healthy'
  if (input.latestRequirementTimestampMs === null) return 'unknown'
  const ageMs = input.nowMs - input.latestRequirementTimestampMs
  if (ageMs > SWARM_REQUIREMENTS_PENDING_STALE_THRESHOLD_MS) return 'degraded'
  return 'degraded'
}

const readBooleanValue = (value: unknown): boolean | null => (value === true ? true : value === false ? false : null)

const readConsecutiveFailures = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  }
  return 0
}

const buildExecutionTrustStage = (input: {
  namespace: string
  swarmName: string
  stage: (typeof SWARM_STAGE_NAMES)[number]
  stageState: Record<string, unknown>
  nowMs: number
  freezeState: 'active' | 'expired_unreconciled' | 'inactive'
}) => {
  const configuredEveryRaw = asString(input.stageState['cadence'])
  const configuredEveryMs = parseDurationToMs(configuredEveryRaw)
  const lastRunAt = asString(input.stageState['lastRunTime'])
  const lastRunMs = parseDateMs(lastRunAt)
  const ageMs = lastRunMs === null ? null : input.nowMs - lastRunMs
  const staleAfterMs = configuredEveryMs === null ? null : configuredEveryMs * 2
  const explicitFresh = readBooleanValue(input.stageState['fresh'])
  const inferredFresh =
    explicitFresh !== null
      ? explicitFresh
      : staleAfterMs === null || lastRunMs === null
        ? null
        : ageMs !== null && ageMs <= staleAfterMs
  const stale = staleAfterMs !== null && (explicitFresh === false || (inferredFresh !== null && !inferredFresh))
  const latestFailureCount = readConsecutiveFailures(input.stageState['consecutiveFailures'])
  const healthy = readBooleanValue(input.stageState['healthy'])
  const dataConfidence: ExecutionTrustStage['data_confidence'] =
    latestFailureCount > 0 || stale || healthy === false
      ? 'degraded'
      : input.stageState['healthy'] === undefined && input.stageState['fresh'] === undefined && lastRunMs === null
        ? 'unknown'
        : 'high'

  const rawPhase = asString(input.stageState['phase']) ?? 'Unknown'
  const frozen = rawPhase.toLowerCase() === 'frozen'
  const phase = input.freezeState === 'expired_unreconciled' && frozen ? 'Recovering' : rawPhase
  const reason =
    input.freezeState === 'active'
      ? `${input.stage} blocked by swarm freeze`
      : input.freezeState === 'expired_unreconciled'
        ? `${input.stage} waiting for freeze reconciliation`
        : frozen
          ? `${input.stage} stage is frozen`
          : stale
            ? `${input.stage} stage is stale`
            : latestFailureCount > 0
              ? `${input.stage} consecutive failures`
              : asString(input.stageState['phase']) === null
                ? `${input.stage} phase missing`
                : null
  const classReason =
    input.freezeState === 'active'
      ? 'blocked'
      : input.freezeState === 'expired_unreconciled'
        ? 'degraded'
        : frozen || stale
          ? 'blocked'
          : latestFailureCount > 0 || healthy === false
            ? 'degraded'
            : healthy === null
              ? 'unknown'
              : null

  return {
    stageData: {
      swarm: input.swarmName,
      namespace: input.namespace,
      stage: input.stage,
      phase,
      last_run_at: toIso(lastRunMs),
      next_expected_at: configuredEveryMs === null || lastRunMs === null ? null : toIso(lastRunMs + configuredEveryMs),
      configured_every_ms: configuredEveryMs,
      age_ms: ageMs,
      stale_after_ms: staleAfterMs,
      stale,
      recent_failed_jobs: latestFailureCount,
      recent_backoff_limit_exceeded_jobs: latestFailureCount >= 3 ? 1 : 0,
      last_failure_reason: reason,
      data_confidence: dataConfidence,
    },
    blockingClass: classReason,
    failureReason: reason,
  }
}

export const buildExecutionTrust = async ({
  namespace,
  now,
  swarms,
  kube = createKubeGateway(),
  summaryLimit = DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT,
}: ExecutionTrustInput): Promise<ExecutionTrustSnapshot> => {
  const nowMs = now.getTime()
  const resolvedSwarms = uniqueStrings(swarms.length === 0 ? resolveExecutionTrustSwarms() : swarms)
  const snapshot = {
    swarms: [] as ExecutionTrustSwarm[],
    stages: [] as ExecutionTrustStage[],
    blockingWindows: [] as ExecutionTrustBlock[],
  }

  let resources: Awaited<ReturnType<KubeGateway['listSwarms']>> = []
  try {
    resources = await kube.listSwarms(namespace)
  } catch (error) {
    return {
      executionTrust: {
        status: 'unknown',
        reason: `execution trust snapshot unavailable: ${normalizeMessage(error)}`,
        last_evaluated_at: now.toISOString(),
        blocking_windows: [],
        evidence_summary: [],
      },
      swarms: [],
      stages: [],
    }
  }

  const byName = new Map<string, (typeof resources)[number]>()
  for (const resource of resources) {
    byName.set(resource.metadata.name, resource)
  }

  for (const swarmName of resolvedSwarms) {
    const rawResource = byName.get(swarmName)
    if (!rawResource) {
      snapshot.blockingWindows.push({
        type: 'swarms',
        scope: namespace,
        name: swarmName,
        reason: `tracked swarm not found: ${swarmName}`,
        class: 'blocked',
      })
      snapshot.swarms.push({
        name: swarmName,
        namespace,
        phase: 'Unknown',
        ready: false,
        updated_at: null,
        observed_generation: null,
        freeze: null,
        requirements_pending: 0,
        requirements_pending_class: 'blocked',
        last_discover_at: null,
        last_plan_at: null,
        last_implement_at: null,
        last_verify_at: null,
      })
      continue
    }

    const metadata = rawResource.metadata
    const status = rawResource.status
    const stageStates = asRecord(status.stageStates) ?? {}

    const lastDiscoveredAt = asString(status[SWARM_STAGE_LAST_RUN_KEY.discover])
    const lastPlanAt = asString(status[SWARM_STAGE_LAST_RUN_KEY.plan])
    const lastImplementAt = asString(status[SWARM_STAGE_LAST_RUN_KEY.implement])
    const lastVerifyAt = asString(status[SWARM_STAGE_LAST_RUN_KEY.verify])
    const latestRequirementTimestampMs = Math.max(
      parseDateMs(lastDiscoveredAt) ?? -1,
      parseDateMs(lastPlanAt) ?? -1,
      parseDateMs(lastImplementAt) ?? -1,
      parseDateMs(lastVerifyAt) ?? -1,
    )
    const phase = asString(status.phase) ?? 'Unknown'
    const freezeRaw = asRecord(status.freeze) ?? {}
    const freezeUntil = asString(freezeRaw.until)
    const freezeUntilMs = parseDateMs(freezeUntil)
    const freezeActive = freezeUntilMs !== null && freezeUntilMs > nowMs
    const freezeExpiredUnreconciled =
      phase.toLowerCase() === 'frozen' && freezeUntilMs !== null && freezeUntilMs <= nowMs
    const freezeReason = asString(freezeRaw.reason) ?? null
    const projectedPhase = freezeExpiredUnreconciled ? 'Recovering' : phase
    const ready =
      projectedPhase.toLowerCase() !== 'frozen' &&
      projectedPhase.toLowerCase() !== 'recovering' &&
      !freezeActive &&
      phase.toLowerCase() !== 'disabled'
    const observedGeneration = Number.isFinite(Number(status.observedGeneration ?? metadata.generation ?? null))
      ? Math.max(0, Number(status.observedGeneration ?? metadata.generation ?? 0))
      : null

    const requirementsRaw = asRecord(status.requirements) ?? {}
    const requirementsPending = readRequirementsPending(requirementsRaw.pending)
    const requirementsPendingClass = evaluateRequirementsPendingClass({
      pending: requirementsPending,
      latestRequirementTimestampMs: latestRequirementTimestampMs < 0 ? null : latestRequirementTimestampMs,
      nowMs,
      frozen: freezeActive,
    })

    if (requirementsPendingClass === 'blocked') {
      snapshot.blockingWindows.push({
        type: 'dependencies',
        scope: namespace,
        name: swarmName,
        reason: `requirements are blocked on ${swarmName}: pending=${requirementsPending}`,
        class: 'blocked',
      })
    } else if (requirementsPendingClass === 'degraded') {
      snapshot.blockingWindows.push({
        type: 'dependencies',
        scope: namespace,
        name: swarmName,
        reason: `requirements are degraded on ${swarmName}: pending=${requirementsPending}`,
        class: 'degraded',
      })
    } else if (requirementsPendingClass === 'unknown') {
      snapshot.blockingWindows.push({
        type: 'dependencies',
        scope: namespace,
        name: swarmName,
        reason: `requirements aging is unknown for ${swarmName}`,
        class: 'unknown',
      })
    }

    if (freezeActive) {
      snapshot.blockingWindows.push({
        type: 'swarms',
        scope: namespace,
        name: swarmName,
        reason: freezeReason ? `swarm freeze active (${freezeReason})` : 'swarm freeze active',
        class: 'blocked',
      })
    } else if (phase.toLowerCase() === 'frozen' && freezeUntilMs !== null && freezeUntilMs <= nowMs) {
      snapshot.blockingWindows.push({
        type: 'swarms',
        scope: namespace,
        name: swarmName,
        reason: freezeReason ? `freeze expiry unreconciled (${freezeReason})` : 'freeze expiry unreconciled',
        class: 'degraded',
      })
    }

    for (const stage of SWARM_STAGE_NAMES) {
      const stageStateRaw = asRecord(stageStates[stage])
      if (!stageStateRaw || Object.keys(stageStateRaw).length === 0) {
        snapshot.stages.push({
          swarm: swarmName,
          namespace,
          stage,
          phase: 'Missing',
          last_run_at: null,
          next_expected_at: null,
          configured_every_ms: null,
          age_ms: null,
          stale_after_ms: null,
          stale: false,
          recent_failed_jobs: 0,
          recent_backoff_limit_exceeded_jobs: 0,
          last_failure_reason: 'missing stage status',
          data_confidence: 'unknown',
        })
        snapshot.blockingWindows.push({
          type: 'stages',
          scope: namespace,
          name: `${swarmName}:${stage}`,
          reason: `missing ${stage} state for ${swarmName}`,
          class: 'unknown',
        })
        continue
      }

      const builtStage = buildExecutionTrustStage({
        namespace,
        swarmName,
        stage,
        stageState: stageStateRaw,
        nowMs,
        freezeState: freezeActive ? 'active' : freezeExpiredUnreconciled ? 'expired_unreconciled' : 'inactive',
      })
      snapshot.stages.push(builtStage.stageData)
      if (builtStage.blockingClass) {
        const stageBlockingClass = asExecutionTrustClass(builtStage.blockingClass)
        snapshot.blockingWindows.push({
          type: 'stages',
          scope: namespace,
          name: `${swarmName}:${stage}`,
          reason: builtStage.failureReason ?? `${stage} is unhealthy`,
          class: stageBlockingClass,
        })
      }
    }

    snapshot.swarms.push({
      name: swarmName,
      namespace,
      phase: projectedPhase,
      ready,
      updated_at: toIso(
        parseDateMs(asString(status.lastTransitionTime) ?? asString(status.updatedAt) ?? asString(status.observedAt)) ??
          nowMs,
      ),
      observed_generation: observedGeneration,
      freeze: freezeReason || freezeUntil ? { reason: freezeReason, until: freezeUntil } : null,
      requirements_pending: requirementsPending,
      requirements_pending_class: requirementsPendingClass,
      last_discover_at: lastDiscoveredAt,
      last_plan_at: lastPlanAt,
      last_implement_at: lastImplementAt,
      last_verify_at: lastVerifyAt,
    })
  }

  const blockingWindows: ExecutionTrustStatus['blocking_windows'] = uniqueStrings(
    snapshot.blockingWindows
      .map((item) => `${item.scope}|${item.type}|${item.name ?? ''}|${item.class}|${item.reason}`)
      .slice(0, summaryLimit),
  ).map((line) => {
    const [scope, type, name, blockingClass, ...reasonPieces] = line.split('|')
    return {
      type: type as ExecutionTrustStatus['blocking_windows'][number]['type'],
      scope,
      ...(name.length > 0 ? { name } : {}),
      reason: reasonPieces.join('|'),
      class: asExecutionTrustClass(blockingClass),
    }
  })

  const evidenceSummary = blockingWindows
    .map((window) => `${window.type}:${window.scope}${window.name ? `:${window.name}` : ''}:${window.reason}`)
    .slice(0, summaryLimit)

  const hasBlocked = blockingWindows.some((window) => window.class === 'blocked')
  const hasUnknown = blockingWindows.some((window) => window.class === 'unknown')
  const hasDegraded = blockingWindows.some((window) => window.class === 'degraded')
  const executionTrustStatus: ExecutionTrustStatus = {
    status: hasBlocked ? 'blocked' : hasUnknown ? 'unknown' : hasDegraded ? 'degraded' : 'healthy',
    reason:
      blockingWindows.length === 0
        ? 'execution trust is healthy.'
        : hasBlocked
          ? `execution trust blocked: ${blockingWindows.map((window) => window.reason).join(', ')}`
          : `execution trust ${hasDegraded ? 'degraded' : 'unknown'}: ${blockingWindows.map((window) => window.reason).join(', ')}`,
    last_evaluated_at: now.toISOString(),
    blocking_windows: blockingWindows,
    evidence_summary: evidenceSummary,
  }

  return {
    executionTrust: executionTrustStatus,
    swarms: snapshot.swarms,
    stages: snapshot.stages,
  }
}
