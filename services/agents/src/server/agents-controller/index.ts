import { createTemporalClient, loadTemporalConfig } from '@proompteng/temporal-bun-sdk'
import { Context, Effect, Layer, ManagedRuntime } from 'effect'

import { resolveBooleanFeatureToggle, type BooleanFeatureToggleRequest } from '../feature-flags'
import { createKubeGateway, type KubeGateway } from '../kube-gateway'
import { startResourceWatch } from '../kube-watch'
import {
  clearAgentsControllerGauges,
  recordAgentConcurrency,
  recordAgentConcurrencyLimit,
  recordAgentQueueDepth,
  recordAgentRateLimitRejection,
  recordAgentRunOutcome,
  recordAgentRunRetentionDeleteErrors,
  recordAgentRunRetentionDeletes,
  recordAgentRunResyncAdoptions,
  recordAgentRunUntouchedBacklog,
  recordAgentRunUntouchedOldestAgeSeconds,
  recordReconcileDurationMs,
  recordRunnerCompletion,
  recordRuntimeDebrisOrphanPods,
} from '../metrics'
import { parseNamespaceScopeEnv } from '../namespace-scope'
import { asRecord, asString, readNested } from '../primitives'
import { createKubernetesClient, isKubeConflict, RESOURCE_MAP } from '../kube-types'
import { buildResourceFingerprint, shouldApplyStatus } from '../status-utils'
import { resolveAgentCommsSubscriberConfig } from '../integrations-config'
import { recordAgentRunLifecycleSpan } from '../tracing'
import { createAgentRunReconciler } from './agent-run-reconciler'
import { isAgentRunTemplate } from './agent-run-template'
import {
  buildArtifactsLimitMessage,
  limitAgentRunStatusArtifacts,
  resolveAgentRunArtifactsLimitConfig,
} from './agentrun-artifacts'
import { deriveStandardConditionUpdates, normalizeConditions, upsertCondition } from './conditions'
import { checkCrds, parseConcurrency, parseQueueLimits, parseRateLimits } from './controller-config'
import { parseOptionalNumber } from './env-config'
import { createImplementationContractTools } from './implementation-contract'
import {
  applyJobTtlAfterStatus,
  buildRunSpec,
  makeName,
  normalizeLabelValue,
  resolveRunnerServiceAccount,
  submitJobRun,
  verifyJobConfigMaps,
} from './job-runtime'
import {
  markAgentsControllerStarted,
  markAgentsControllerStartFailed,
  requestAgentsControllerStart,
  requestAgentsControllerStop,
} from './lifecycle-machine'
import {
  type AgentRunIngestionRuntimeState,
  type AgentsPrimitivesStoreRef,
  type AgentsControllerMutableState,
  type CrdCheckState,
  createMutableState,
} from './mutable-state'
import {
  type ControllerState,
  type RunObservation,
  createControllerState,
  ensureNamespaceState,
  listItems,
  snapshotNamespace,
  updateStateMap,
} from './namespace-state'
import type { AgentRunIndex } from './queue-state'
import { resetControllerRateState as resetControllerRateStateMaps } from './rate-limits'
import { createResourceReconcilers } from './resource-reconcilers'
import {
  resolveAgentRunnerDefaultsConfig,
  resolveAgentsControllerBehaviorConfig,
  resolveRuntimeDebrisCleanupConfig,
} from './runtime-config'
import { resolveWorkloadImage } from './workload-image'
import { parseRunnerTerminalStatus, runnerStatusToTerminalOutcome, type RunnerTerminalStatus } from './runner-status'
import { reconcileRuntimeDebris } from './runtime-debris'
import { isAgentRunTerminalPhase, isQueuedRun, resolveParam, resolveParameters } from './run-utils'
import { createTemporalRuntimeTools } from './temporal-runtime'
import { resolveVcsAuthMethod, validateVcsAuthConfig } from './vcs-auth'
import {
  clearGithubAppTokenCache,
  fetchGithubAppToken,
  parseIntOrString,
  resolveAuthSecretConfig,
  resolveSecretValue,
  resolveVcsContext,
  resolveVcsPrRateLimits,
  secretHasKey,
} from './vcs-context'
import { createWorkflowReconciler, type CompletedWorkflowRunner } from './workflow-reconciler'
import { validateAutonomousCodexAuthSecret } from './policy'
import {
  logAgentsControllerDebug,
  logAgentsControllerError,
  logAgentsControllerInfo,
  logAgentsControllerWarn,
  toLogError,
} from './operational-logging'

const DEFAULT_NAMESPACES = ['agents']
const DEFAULT_AGENTRUN_RETENTION_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const IMPLEMENTATION_TEXT_LIMIT = 128 * 1024
const DEFAULT_AGENTS_CONTROLLER_ENABLED_FLAG_KEY = 'agents.controller.enabled'

const BASE_REQUIRED_CRDS = [
  'agents.agents.proompteng.ai',
  'agentruns.agents.proompteng.ai',
  'agentproviders.agents.proompteng.ai',
  'implementationspecs.agents.proompteng.ai',
  'implementationsources.agents.proompteng.ai',
  'memories.agents.proompteng.ai',
]
const VCS_PROVIDER_CRD = 'versioncontrolproviders.agents.proompteng.ai'

const isVcsProvidersEnabled = () => resolveAgentsControllerBehaviorConfig(process.env).vcsProvidersEnabled

const isAgentRunImmutabilityEnforced = () =>
  resolveAgentsControllerBehaviorConfig(process.env).agentRunImmutabilityEnforced
const isAgentCommsSubscriberEnabled = () => !resolveAgentCommsSubscriberConfig(process.env).disabled

const resolveRequiredCrds = () => {
  if (!isVcsProvidersEnabled()) return BASE_REQUIRED_CRDS
  return [...BASE_REQUIRED_CRDS.slice(0, 5), VCS_PROVIDER_CRD, ...BASE_REQUIRED_CRDS.slice(5)]
}

const resolveNatsDependency = () => ({
  enabled: isAgentCommsSubscriberEnabled(),
  url: resolveAgentCommsSubscriberConfig(process.env).natsUrl,
})

type ControllerHealthState = {
  started: boolean
  crdCheckState: CrdCheckState | null
  namespaces: string[] | null
  agentRunIngestion: AgentRunIngestionHealth[]
}

export type AgentRunIngestionHealth = {
  namespace: string
  lastWatchEventAt: string | null
  lastResyncAt: string | null
  untouchedRunCount: number
  oldestUntouchedAgeSeconds: number | null
}

export type AgentRunIngestionAssessment = AgentRunIngestionHealth & {
  status: 'healthy' | 'degraded' | 'unknown'
  message: string
  dispatchPaused: boolean
}

export type AgentsControllerHealth = {
  enabled: boolean
  started: boolean
  namespaces: string[] | null
  crdsReady: boolean | null
  missingCrds: string[]
  forbiddenCrds?: string[]
  lastCheckedAt: string | null
  agentRunIngestion?: AgentRunIngestionHealth[]
}

const globalState = globalThis as typeof globalThis & {
  __agentsControllerState?: ControllerHealthState
}

const controllerState = (() => {
  if (globalState.__agentsControllerState) return globalState.__agentsControllerState
  const initial = { started: false, crdCheckState: null, namespaces: null, agentRunIngestion: [] }
  globalState.__agentsControllerState = initial
  return initial
})()

export type AgentsControllerTerminalStatusHookInput = {
  resource: Record<string, unknown>
  nextStatus: Record<string, unknown>
  previousPhase: string | null
  nextPhase: string
}

export type AgentsControllerRuntimeDependencies = {
  createPrimitivesStore?: () => AgentsPrimitivesStoreRef
  onAgentRunTerminalStatus?: (input: AgentsControllerTerminalStatusHookInput) => Promise<void> | void
  resolveBooleanFeatureToggle?: (request: BooleanFeatureToggleRequest) => Promise<boolean>
}

const runtimeDependencies: AgentsControllerRuntimeDependencies = {}

export const configureAgentsControllerRuntime = (dependencies: AgentsControllerRuntimeDependencies) => {
  Object.assign(runtimeDependencies, dependencies)
}

let runtimeMutableState: AgentsControllerMutableState<ControllerState> = createMutableState<ControllerState>({
  started: controllerState.started,
  crdCheckState: controllerState.crdCheckState,
})

const hasActiveControllerRuntimeState = (state: AgentsControllerMutableState<ControllerState>) =>
  state.started ||
  state.starting ||
  state.reconciling ||
  state.watchHandles.length > 0 ||
  state.controllerSnapshot !== null

const initializeRuntimeMutableStateForLayer = () => {
  if (hasActiveControllerRuntimeState(runtimeMutableState)) {
    runtimeMutableState.crdCheckState = controllerState.crdCheckState
    return
  }
  runtimeMutableState = createMutableState<ControllerState>({
    started: controllerState.started,
    crdCheckState: controllerState.crdCheckState,
  })
}

const nowIso = () => new Date().toISOString()

const resolveAgentRunResyncIntervalSeconds = () =>
  resolveAgentsControllerBehaviorConfig(process.env).resyncIntervalSeconds

const resolveAgentRunUntouchedWarnAfterSeconds = () =>
  resolveAgentsControllerBehaviorConfig(process.env).untouchedWarnAfterSeconds

const createDefaultAgentRunIngestionRuntimeState = (): AgentRunIngestionRuntimeState => ({
  lastWatchEventAtMs: null,
  lastResyncAtMs: null,
  untouchedRunCount: 0,
  oldestUntouchedAgeSeconds: null,
  degradedSinceMs: null,
  healthyResyncStreak: 0,
  lastResyncSummarySignature: null,
  lastStallSignature: null,
})

const getAgentRunIngestionRuntimeState = (namespace: string) => {
  const existing = runtimeMutableState.agentRunIngestionState.get(namespace)
  if (existing) return existing
  const created = createDefaultAgentRunIngestionRuntimeState()
  runtimeMutableState.agentRunIngestionState.set(namespace, created)
  return created
}

const buildAgentRunIngestionHealth = (
  namespace: string,
  state: AgentRunIngestionRuntimeState,
): AgentRunIngestionHealth => ({
  namespace,
  lastWatchEventAt: state.lastWatchEventAtMs ? new Date(state.lastWatchEventAtMs).toISOString() : null,
  lastResyncAt: state.lastResyncAtMs ? new Date(state.lastResyncAtMs).toISOString() : null,
  untouchedRunCount: state.untouchedRunCount,
  oldestUntouchedAgeSeconds: state.oldestUntouchedAgeSeconds,
})

const syncControllerAgentRunIngestionHealth = () => {
  controllerState.agentRunIngestion = Array.from(runtimeMutableState.agentRunIngestionState.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([namespace, state]) => buildAgentRunIngestionHealth(namespace, state))
}

const recordAgentRunWatchEventSeen = (namespace: string) => {
  getAgentRunIngestionRuntimeState(namespace).lastWatchEventAtMs = Date.now()
  syncControllerAgentRunIngestionHealth()
}

const buildDefaultAgentRunIngestionHealth = (namespace: string): AgentRunIngestionHealth => ({
  namespace,
  lastWatchEventAt: null,
  lastResyncAt: null,
  untouchedRunCount: 0,
  oldestUntouchedAgeSeconds: null,
})

const isAgentRunIngestionBlind = (entry: AgentRunIngestionHealth) =>
  entry.untouchedRunCount > 0 && entry.lastResyncAt !== null && entry.lastWatchEventAt === null

const isAgentRunIngestionStalled = (entry: AgentRunIngestionHealth) => {
  const warnAfterSeconds = resolveAgentRunUntouchedWarnAfterSeconds()
  const untouchedPastThreshold =
    entry.untouchedRunCount > 0 &&
    entry.oldestUntouchedAgeSeconds !== null &&
    entry.oldestUntouchedAgeSeconds >= warnAfterSeconds
  return untouchedPastThreshold || isAgentRunIngestionBlind(entry)
}

export const assessAgentRunIngestion = (
  namespace: string,
  health: AgentsControllerHealth = getAgentsControllerHealth(),
): AgentRunIngestionAssessment => {
  const entry =
    (health.agentRunIngestion ?? []).find((item) => item.namespace === namespace) ??
    buildDefaultAgentRunIngestionHealth(namespace)
  const runtimeState = runtimeMutableState.agentRunIngestionState.get(namespace)
  const blind = isAgentRunIngestionBlind(entry)
  const stalled = isAgentRunIngestionStalled(entry)
  const recoveryInProgress = Boolean(runtimeState?.degradedSinceMs) && !stalled

  if (stalled || recoveryInProgress) {
    const message = blind
      ? 'no AgentRun watch events observed since controller start while untouched runs exist'
      : stalled
        ? `untouched AgentRuns detected for ${entry.oldestUntouchedAgeSeconds}s`
        : `ingestion recovering (${runtimeState?.healthyResyncStreak ?? 0}/2 healthy resyncs)`
    return {
      ...entry,
      status: 'degraded',
      message,
      dispatchPaused: stalled || Boolean(runtimeState?.degradedSinceMs),
    }
  }

  if (!health.started) {
    return {
      ...entry,
      status: 'unknown',
      message: 'agents controller not started',
      dispatchPaused: false,
    }
  }

  return {
    ...entry,
    status: 'healthy',
    message: 'AgentRun ingestion healthy',
    dispatchPaused: false,
  }
}

const getAgentRunUntouchedReasons = (agentRun: Record<string, unknown>) => {
  const reasons: string[] = []
  const metadata = asRecord(agentRun.metadata) ?? {}
  const status = asRecord(agentRun.status) ?? {}
  const annotations = asRecord(metadata.annotations) ?? {}
  const generation = metadata.generation
  const observedGeneration = status.observedGeneration
  const phase = asString(status.phase)
  const templateAnnotation = asString(annotations['agents.proompteng.ai/template'])?.toLowerCase()
  const isTemplate = templateAnnotation === 'true' || phase === 'Template'
  const finalizers = Array.isArray(metadata.finalizers)
    ? metadata.finalizers.filter((item): item is string => typeof item === 'string')
    : []

  if (phase === 'Template') return reasons
  if (!phase) reasons.push('missing_phase')
  if (observedGeneration == null) {
    reasons.push('missing_observed_generation')
  } else if (generation != null && observedGeneration !== generation) {
    reasons.push('generation_drift')
  }
  if (!isTemplate && !finalizers.includes('agents.proompteng.ai/runtime-cleanup')) {
    reasons.push('missing_finalizer')
  }
  return reasons
}

const getAgentRunCreationTimestampMs = (agentRun: Record<string, unknown>) => {
  const createdAt = asString(readNested(agentRun, ['metadata', 'creationTimestamp']))
  if (!createdAt) return null
  const parsed = Date.parse(createdAt)
  return Number.isNaN(parsed) ? null : parsed
}

const getResourceVersion = (payload: Record<string, unknown>) => {
  const resourceVersion = asString(readNested(payload, ['metadata', 'resourceVersion']))
  return resourceVersion?.trim() ? resourceVersion : null
}

const numericResourceVersion = /^[1-9][0-9]*$/
const compareResourceVersions = (version: string | null, other: string | null) => {
  if (!version || !other) return null
  if (version === other) return 0
  if (!numericResourceVersion.test(version) || !numericResourceVersion.test(other)) return null
  // Compare native AgentRun revisions as arbitrary-length decimals (never round them to JS numbers).
  return version.length === other.length ? (version < other ? -1 : 1) : version.length - other.length
}

const isCoveredByRunList = (resource: Record<string, unknown>, listVersion: string | null) => {
  const order = compareResourceVersions(getResourceVersion(resource), listVersion)
  return order !== null && order <= 0
}

const isKubeNotFoundError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('notfound') || normalized.includes(' not found')
}

const hasJobCondition = (job: Record<string, unknown>, conditionType: string) => {
  const status = asRecord(job.status) ?? {}
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  return conditions.some((entry) => {
    const record = asRecord(entry)
    if (!record) return false
    return asString(record.type) === conditionType && asString(record.status) === 'True'
  })
}

const isJobComplete = (job: Record<string, unknown>) => hasJobCondition(job, 'Complete')

const isJobFailed = (job: Record<string, unknown>) => hasJobCondition(job, 'Failed')

const shouldStart = () => {
  return resolveAgentsControllerBehaviorConfig(process.env).enabled
}

const shouldStartWithFeatureFlag = async () => {
  if (resolveAgentsControllerBehaviorConfig(process.env).enabled === false) return false

  const resolveToggle = runtimeDependencies.resolveBooleanFeatureToggle ?? resolveBooleanFeatureToggle
  return resolveToggle({
    key: DEFAULT_AGENTS_CONTROLLER_ENABLED_FLAG_KEY,
    keyEnvVar: 'AGENTS_CONTROLLER_ENABLED_FLAG_KEY',
    fallbackEnvVar: 'AGENTS_CONTROLLER_ENABLED',
    defaultValue: true,
  })
}

const parseNamespaces = () => {
  return parseNamespaceScopeEnv('AGENTS_CONTROLLER_NAMESPACES', {
    fallback: DEFAULT_NAMESPACES,
    label: 'agents controller',
  })
}

const resolveCrdCheckNamespace = () => {
  const namespaces = parseNamespaces()
  if (namespaces.includes('*')) return 'default'
  return namespaces[0] ?? 'default'
}

const resolveNamespaces = async (kubeGateway: Pick<KubeGateway, 'listNamespaces'> = createKubeGateway()) => {
  const namespaces = parseNamespaces()
  if (!namespaces.includes('*')) {
    return namespaces
  }
  const resolved = await kubeGateway.listNamespaces()
  if (resolved.length === 0) {
    throw new Error('no namespaces returned by kube gateway')
  }
  return resolved
}

const resolveConfiguredNamespaces = () => {
  try {
    return parseNamespaces()
  } catch {
    return null
  }
}

export const getAgentsControllerHealth = (): AgentsControllerHealth => ({
  enabled: shouldStart(),
  started: controllerState.started,
  namespaces: controllerState.namespaces ?? resolveConfiguredNamespaces(),
  crdsReady: controllerState.crdCheckState?.ok ?? null,
  missingCrds: controllerState.crdCheckState?.missing ?? [],
  forbiddenCrds: controllerState.crdCheckState?.forbidden ?? [],
  lastCheckedAt: controllerState.crdCheckState?.checkedAt ?? null,
  agentRunIngestion: controllerState.agentRunIngestion,
})

const isAgentRunIdempotencyEnabled = () => resolveAgentsControllerBehaviorConfig(process.env).agentRunIdempotencyEnabled

const resolveAgentRunIdempotencyRetentionDays = () =>
  resolveAgentsControllerBehaviorConfig(process.env).agentRunIdempotencyRetentionDays

const getPrimitivesStore = async () => {
  if (runtimeMutableState.primitivesStoreRef) return runtimeMutableState.primitivesStoreRef
  const createPrimitivesStore = runtimeDependencies.createPrimitivesStore
  if (!createPrimitivesStore) return null
  try {
    runtimeMutableState.primitivesStoreRef = createPrimitivesStore()
    await runtimeMutableState.primitivesStoreRef.ready
    return runtimeMutableState.primitivesStoreRef
  } catch (error) {
    runtimeMutableState.primitivesStoreRef = null
    console.warn('[agents] failed to initialize primitives store (idempotency disabled)', error)
    return null
  }
}

const runnerCompletionDetails = (
  runner: RunnerTerminalStatus | null,
  fallbackStart: number | null,
  fallbackFinish: number | null,
) => {
  const telemetry = runner?.telemetry?.state === 'finished' ? runner.telemetry : undefined
  const startedAt = parseTimestampMs(runner?.startedAt) ?? parseTimestampMs(telemetry?.startedAt) ?? fallbackStart
  const finish = parseTimestampMs(runner?.finishedAt) ?? fallbackFinish
  const start = startedAt !== null && finish !== null && finish >= startedAt ? startedAt : undefined
  return {
    start,
    finish,
    model: telemetry?.model ?? runner?.model,
    effort: telemetry?.effort ?? runner?.effort,
    durationSeconds: start !== undefined && finish !== null ? (finish - start) / 1000 : undefined,
    telemetry,
  }
}

const setStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
  status: Record<string, unknown>,
  completedWorkflowRunners: CompletedWorkflowRunner[] = [],
) => {
  const metadata = asRecord(resource.metadata) ?? {}
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace)
  if (!name || !namespace) return
  const apiVersion = asString(resource.apiVersion)
  const kind = asString(resource.kind)
  if (!apiVersion || !kind) return
  let nextStatusBase = status
  if (kind === 'AgentRun' && status.contract === undefined) {
    const existingContract = readNested(resource, ['status', 'contract'])
    if (existingContract) {
      nextStatusBase = { ...status, contract: existingContract }
    }
  }
  if (kind === 'AgentRun' && status.systemPromptHash === undefined) {
    const existingHash = readNested(resource, ['status', 'systemPromptHash'])
    if (existingHash) {
      nextStatusBase = { ...nextStatusBase, systemPromptHash: existingHash }
    }
  }
  if (kind === 'AgentRun' && status.specHash === undefined) {
    const existingHash = readNested(resource, ['status', 'specHash'])
    if (existingHash) {
      nextStatusBase = { ...nextStatusBase, specHash: existingHash }
    }
  }
  if (kind === 'AgentRun' && status.artifacts === undefined) {
    const existingArtifacts = readNested(resource, ['status', 'artifacts'])
    if (existingArtifacts) {
      nextStatusBase = { ...nextStatusBase, artifacts: existingArtifacts }
    }
  }
  if (kind === 'AgentRun' && status.runner === undefined) {
    const existingRunner = readNested(resource, ['status', 'runner'])
    if (existingRunner) {
      nextStatusBase = { ...nextStatusBase, runner: existingRunner }
    }
  }

  let baseConditions = normalizeConditions(nextStatusBase.conditions)
  if (kind === 'AgentRun') {
    if (nextStatusBase.artifacts !== undefined) {
      const config = resolveAgentRunArtifactsLimitConfig()
      const artifactsResult = limitAgentRunStatusArtifacts(nextStatusBase.artifacts, config)
      if (artifactsResult.strictViolation) {
        baseConditions = upsertCondition(baseConditions, {
          type: 'ArtifactsLimitExceeded',
          status: 'True',
          reason: artifactsResult.reasons[0] ?? 'LimitExceeded',
          message: buildArtifactsLimitMessage(artifactsResult),
        })
        if (asString(nextStatusBase.phase) !== 'Failed' && asString(nextStatusBase.phase) !== 'Cancelled') {
          nextStatusBase = { ...nextStatusBase, phase: 'Failed', finishedAt: nextStatusBase.finishedAt ?? nowIso() }
        }
      } else if (artifactsResult.trimmedCount || artifactsResult.strippedUrlCount || artifactsResult.droppedCount) {
        baseConditions = upsertCondition(baseConditions, {
          type: 'ArtifactsLimited',
          status: 'True',
          reason: artifactsResult.reasons[0] ?? 'Limited',
          message: buildArtifactsLimitMessage(artifactsResult),
        })
      } else {
        baseConditions = upsertCondition(baseConditions, {
          type: 'ArtifactsLimited',
          status: 'False',
          reason: 'WithinLimits',
          message: '',
        })
      }

      nextStatusBase = { ...nextStatusBase, artifacts: artifactsResult.artifacts }
    }
  }

  const phase = asString(nextStatusBase.phase) ?? null
  const standardUpdates = deriveStandardConditionUpdates(baseConditions, phase)
  let conditions = baseConditions
  for (const update of standardUpdates) {
    conditions = upsertCondition(conditions, update)
  }
  if (kind === 'AgentRun' && phase) {
    const normalizedPhase = phase.trim().toLowerCase()
    if (normalizedPhase !== 'pending' && normalizedPhase !== 'queued') {
      conditions = upsertCondition(conditions, {
        type: 'Blocked',
        status: 'False',
        reason: 'NotBlocked',
        message: '',
      })
    }
  }
  const nextStatus = {
    ...nextStatusBase,
    updatedAt: nowIso(),
    conditions,
  }
  const previousStatus = asRecord(resource.status)
  const previousPhase = asString(previousStatus?.phase)
  if (
    kind === 'AgentRun' &&
    phase !== previousPhase &&
    !(phase === 'Template' && isAgentRunTemplate(metadata)) &&
    (isAgentRunTerminalPhase(previousPhase) || (previousPhase === 'Running' && isQueuedRun({ status: nextStatus })))
  ) {
    return
  }
  if (!shouldApplyStatus(previousStatus, nextStatus)) {
    return
  }
  const terminalPhase = kind === 'AgentRun' && isAgentRunTerminalPhase(phase) ? phase : null
  const firstCompletion = terminalPhase !== null && !isAgentRunTerminalPhase(previousPhase)
  const isWorkflowRun =
    kind === 'AgentRun' &&
    phase !== 'Template' &&
    (readNested(resource, ['spec', 'runtime', 'type']) === 'workflow' ||
      readNested(previousStatus, ['runtimeRef', 'type']) === 'workflow')
  // Every AgentRun patch is based on this observation, including workflow completion receipts.
  const resourceVersion = kind === 'AgentRun' ? asString(metadata.resourceVersion) : null
  await kube.applyStatus({
    apiVersion,
    kind,
    metadata: { name, namespace, ...(resourceVersion ? { resourceVersion } : {}) },
    status: nextStatus,
  })
  const agent = asString(readNested(resource, ['spec', 'agentRef', 'name']))
  if (resourceVersion) {
    for (const { runner, jobStartedAt, jobFinishedAt } of completedWorkflowRunners) {
      const { model, effort, durationSeconds, telemetry } = runnerCompletionDetails(
        runner,
        parseTimestampMs(jobStartedAt),
        parseTimestampMs(jobFinishedAt),
      )
      recordRunnerCompletion({
        outcome: runnerStatusToTerminalOutcome(runner).phase,
        agent,
        model,
        effort,
        durationSeconds,
        telemetry,
      })
    }
  }
  if (!terminalPhase || terminalPhase === previousPhase) return
  if (firstCompletion) {
    const runtime =
      asString(readNested(nextStatusBase, ['runtimeRef', 'type'])) ??
      asString(readNested(resource, ['status', 'runtimeRef', 'type'])) ??
      asString(readNested(resource, ['spec', 'runtime', 'type'])) ??
      'unknown'
    const runner = isWorkflowRun ? null : parseRunnerTerminalStatus(nextStatusBase.runner)
    const { model, effort, telemetry, durationSeconds, start, finish } = runnerCompletionDetails(
      runner,
      parseTimestampMs(nextStatusBase.startedAt) ?? parseTimestampMs(previousStatus?.startedAt),
      parseTimestampMs(nextStatusBase.finishedAt),
    )
    recordAgentRunOutcome(terminalPhase, { runtime })
    if (runner) {
      recordRunnerCompletion({
        outcome: terminalPhase,
        agent,
        model,
        effort,
        durationSeconds,
        telemetry,
      })
    }
    const endTime = finish ?? Date.now()
    const traceId = recordAgentRunLifecycleSpan({
      name,
      namespace,
      runtime,
      outcome: terminalPhase,
      model,
      effort,
      startTime: start ?? endTime,
      endTime,
    })
    logAgentsControllerInfo('agentrun_terminal_status_committed', {
      namespace,
      runName: name,
      outcome: terminalPhase,
      runtime,
      model,
      effort,
      trace_id: traceId,
    })
  }
  try {
    await runtimeDependencies.onAgentRunTerminalStatus?.({
      resource,
      nextStatus,
      previousPhase,
      nextPhase: terminalPhase,
    })
  } catch (error) {
    logAgentsControllerWarn('agentrun_terminal_status_hook_failed', {
      namespace,
      runName: name,
      phase: terminalPhase,
      ...toLogError(error),
    })
  }
}

const resolveJobImage = (workload: Record<string, unknown>, provider?: Record<string, unknown> | null) =>
  resolveWorkloadImage({
    workload,
    provider,
    defaultRunnerImage: resolveAgentRunnerDefaultsConfig(process.env).defaultRunnerImage,
  }).image

const getTemporalClient = async () => {
  if (!runtimeMutableState.temporalClientPromise) {
    runtimeMutableState.temporalClientPromise = (async () => {
      const config = await loadTemporalConfig({
        defaults: {
          host: DEFAULT_TEMPORAL_HOST,
          port: DEFAULT_TEMPORAL_PORT,
          address: DEFAULT_TEMPORAL_ADDRESS,
        },
      })
      return createTemporalClient({ config })
    })()
  }
  const { client } = await runtimeMutableState.temporalClientPromise
  return client
}

const parseAgentRunRetentionSeconds = () => {
  const parsed = resolveAgentsControllerBehaviorConfig(process.env).agentRunRetentionSeconds
  if (parsed == null || parsed < 0) return DEFAULT_AGENTRUN_RETENTION_SECONDS
  return Math.floor(parsed)
}

const resolveAgentRunRetentionSeconds = (spec: Record<string, unknown>) => {
  const override = parseOptionalNumber(spec.ttlSecondsAfterFinished)
  if (override !== undefined && override > 0) return Math.floor(override)
  if (override === 0) return resolveAgentsControllerBehaviorConfig(process.env).agentRunRetentionZeroTtlMaxSeconds
  return parseAgentRunRetentionSeconds()
}

const AGENTRUN_RETAIN_ANNOTATION = 'agents.proompteng.ai/retain'

const parseTimestampMs = (value: unknown) => {
  const timestamp = asString(value)
  if (!timestamp) return null
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

const getAgentRunTerminalTimestampMs = (agentRun: Record<string, unknown>) =>
  parseTimestampMs(readNested(agentRun, ['status', 'finishedAt'])) ??
  parseTimestampMs(readNested(agentRun, ['status', 'updatedAt'])) ??
  parseTimestampMs(readNested(agentRun, ['metadata', 'creationTimestamp']))

const isAgentRunRetainAnnotated = (agentRun: Record<string, unknown>) => {
  const annotation = asString(readNested(agentRun, ['metadata', 'annotations', AGENTRUN_RETAIN_ANNOTATION]))
  return ['1', 'true', 'yes', 'y', 'on', 'keep', 'forever'].includes(annotation?.trim().toLowerCase() ?? '')
}

const getAgentRunRetentionDecision = (agentRun: Record<string, unknown>, nowMs: number = Date.now()) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const status = asRecord(agentRun.status) ?? {}
  const spec = asRecord(agentRun.spec) ?? {}
  const phase = asString(status.phase)
  const templateAnnotation = asString(
    readNested(metadata, ['annotations', 'agents.proompteng.ai/template']),
  )?.toLowerCase()
  const isTemplate = templateAnnotation === 'true' || phase === 'Template'
  if (isTemplate || !isAgentRunTerminalPhase(phase) || metadata.deletionTimestamp) {
    return { eligible: false, reason: 'not_terminal' }
  }
  if (isAgentRunRetainAnnotated(agentRun)) {
    return { eligible: false, reason: 'retained' }
  }

  const retentionSeconds = resolveAgentRunRetentionSeconds(spec)
  if (retentionSeconds <= 0) return { eligible: false, reason: 'disabled' }

  const terminalAtMs = getAgentRunTerminalTimestampMs(agentRun)
  if (terminalAtMs === null) return { eligible: false, reason: 'missing_terminal_time' }

  const ageSeconds = Math.max(0, Math.floor((nowMs - terminalAtMs) / 1000))
  if (ageSeconds < retentionSeconds) {
    return { eligible: false, reason: 'retained_until_ttl', ageSeconds, retentionSeconds, phase }
  }

  return { eligible: true, reason: 'expired', ageSeconds, retentionSeconds, phase }
}

const sweepExpiredAgentRunsForNamespace = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  runs: Map<string, Record<string, unknown>>,
  nowMs: number,
  reason: 'periodic' | 'watch_restart' | 'manual',
  hasChanged: (name: string) => boolean,
) => {
  const maxDeletes = resolveAgentsControllerBehaviorConfig(process.env).agentRunRetentionMaxDeletesPerNamespace
  if (maxDeletes <= 0) return

  let deleted = 0
  let errors = 0
  let eligibleRemaining = 0

  for (const [name, run] of runs) {
    if (hasChanged(name) || !getAgentRunRetentionDecision(run, nowMs).eligible) continue

    if (deleted >= maxDeletes) {
      eligibleRemaining += 1
      continue
    }

    try {
      await kube.delete(RESOURCE_MAP.AgentRun, name, namespace, { wait: false })
      runs.delete(name)
      deleted += 1
      logAgentsControllerDebug('agentrun_retention_deleted', {
        namespace,
        runName: name,
        reason,
        phase: asString(readNested(run, ['status', 'phase'])) ?? 'unknown',
      })
    } catch (error) {
      errors += 1
      logAgentsControllerWarn('agentrun_retention_delete_failed', {
        namespace,
        runName: name,
        reason,
        ...toLogError(error),
      })
    }
  }

  recordAgentRunRetentionDeletes(deleted, { namespace, reason })
  recordAgentRunRetentionDeleteErrors(errors, { namespace, reason })
  if (deleted > 0 || errors > 0 || eligibleRemaining > 0) {
    logAgentsControllerInfo('agentrun_retention_sweep_completed', {
      namespace,
      reason,
      deleted,
      errors,
      eligibleRemaining,
      maxDeletes,
    })
  }
}

const resetControllerRateState = () => {
  resetControllerRateStateMaps(runtimeMutableState.controllerRateState)
}

const shouldDependencyEventTriggerFullReconcile = (
  map: Map<string, Record<string, unknown>>,
  eventType: string | undefined,
  resource: Record<string, unknown>,
) => {
  const name = asString(readNested(resource, ['metadata', 'name']))
  if (!name) return false
  if (eventType === 'DELETED') return true
  const existing = map.get(name)
  if (!existing) return true
  return buildResourceFingerprint(existing) !== buildResourceFingerprint(resource)
}

const DEPENDENCY_RECONCILE = Symbol('dependency-reconcile')
const RUN_RESYNC = Symbol('run-resync')
const WAKE_RUNS = Symbol('wake-runs')
const RUN_CONFLICT_RETRY_MS = 250
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

const releasesRunCapacity = (previous: Record<string, unknown> | undefined, next: Record<string, unknown> | null) =>
  previous !== undefined &&
  (readNested(previous, ['status', 'phase']) === 'Running' || isQueuedRun(previous)) &&
  (!next || isAgentRunTerminalPhase(asString(readNested(next, ['status', 'phase']))))

const enqueueNamespaceTask = (namespace: string, key: string | symbol, task: () => Promise<void>) => {
  const runtime = runtimeMutableState
  const lifecycleToken = runtime.lifecycleToken
  const queue = runtime.namespaceQueues.get(namespace) ?? { pending: new Map(), tail: Promise.resolve() }
  const existing = queue.pending.get(key)
  if (existing) return existing

  logAgentsControllerDebug('namespace_task_enqueued', { namespace })
  const next = queue.tail
    .then(async () => {
      // An update during reconciliation schedules a follow-up; updates before it starts are coalesced.
      queue.pending.delete(key)
      if (runtime !== runtimeMutableState || lifecycleToken !== runtime.lifecycleToken) return
      const startedAt = Date.now()
      logAgentsControllerDebug('namespace_task_started', { namespace })
      try {
        await task()
      } finally {
        logAgentsControllerDebug('namespace_task_completed', {
          namespace,
          durationMs: Date.now() - startedAt,
        })
      }
    })
    .catch((error) => {
      logAgentsControllerWarn('namespace_task_failed', {
        namespace,
        ...toLogError(error),
      })
    })
    .finally(() => {
      if (queue.tail === next && runtime.namespaceQueues.get(namespace) === queue) {
        runtime.namespaceQueues.delete(namespace)
      }
    })
  queue.pending.set(key, next)
  queue.tail = next
  runtime.namespaceQueues.set(namespace, queue)
  return next
}

const readWhileWatchingRuns = async <T>(
  state: ControllerState,
  namespace: string,
  read: (changes: Map<string, RunObservation>) => Promise<T>,
) => {
  const ns = ensureNamespaceState(state, namespace)
  const changes = new Map<string, RunObservation>()
  ns.runChangesDuringRead = changes
  try {
    return await read(changes)
  } finally {
    ns.runChangesDuringRead = null
  }
}

const cancelRunRetry = (namespace: string, name: string) => {
  const retries = runtimeMutableState.runRetries
  const key = `${namespace}/${name}`
  const retry = retries.get(key)
  if (retry) {
    clearTimeout(retry.timer)
    retries.delete(key)
  }
}

const scheduleRunRetry = (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  name: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
  retryAt: number,
): void => {
  const runtime = runtimeMutableState
  const lifecycleToken = runtime.lifecycleToken
  const key = `${namespace}/${name}`
  const scheduled = runtime.runRetries.get(key)
  if (scheduled?.retryAt === retryAt) return
  cancelRunRetry(namespace, name)
  const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, retryAt - Date.now()))
  const timer = setTimeout(() => {
    runtime.runRetries.delete(key)
    if (runtime !== runtimeMutableState || lifecycleToken !== runtime.lifecycleToken) return
    void enqueueRun(kube, namespace, name, state, concurrency)
  }, delay)
  timer.unref()
  runtime.runRetries.set(key, { retryAt, timer })
}

const wakeCapacityWaiters = (
  kube: ReturnType<typeof createKubernetesClient>,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
): void => {
  // Repo and cluster capacity is shared across namespaces. Coalesce terminal bursts without scanning the run fleet.
  for (const namespace of state.namespaces.keys()) {
    if (!state.runs.capacityWaiters(namespace)?.size) continue
    void enqueueNamespaceTask(namespace, WAKE_RUNS, async () => {
      for (const name of state.runs.capacityWaiters(namespace) ?? []) {
        void enqueueRun(kube, namespace, name, state, concurrency)
      }
    })
  }
}

const enqueueRun = (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  name: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
  options: { lookupMissing?: boolean; terminalReceipt?: Record<string, unknown> } = {},
) => {
  const { lookupMissing, terminalReceipt } = options
  const receiptUid = asString(readNested(terminalReceipt, ['metadata', 'uid']))
  const key = terminalReceipt ? `terminal/${name}/${receiptUid ?? ''}` : name
  return enqueueNamespaceTask(namespace, key, async () => {
    const lifecycleToken = runtimeMutableState.lifecycleToken
    let run = state.runs.get(namespace, name)
    if (!run && lookupMissing) {
      await readWhileWatchingRuns(state, namespace, async (changes) => {
        const loaded = await kube.get(RESOURCE_MAP.AgentRun, name, namespace)
        if (lifecycleToken === runtimeMutableState.lifecycleToken && !changes.has(name) && loaded) {
          state.runs.update(namespace, name, loaded)
        }
      })
      run = state.runs.get(namespace, name)
    }
    if (lifecycleToken !== runtimeMutableState.lifecycleToken) return
    // Terminal idempotency is an edge, not just a level. A later deletion or replacement must not erase it.
    if (
      terminalReceipt &&
      (!run ||
        asString(readNested(run, ['metadata', 'uid'])) !== receiptUid ||
        readNested(run, ['metadata', 'deletionTimestamp']) ||
        !isAgentRunTerminalPhase(asString(readNested(run, ['status', 'phase']))))
    ) {
      await recordTerminalIdempotency(namespace, terminalReceipt)
      return
    }
    if (!run) {
      cancelRunRetry(namespace, name)
      return
    }
    // Always use the latest observation, even if an earlier revision queued this task.
    const memories = Array.from(ensureNamespaceState(state, namespace).memories.values())
    try {
      const retryAt = await reconcileAgentRunWithMetrics(kube, run, namespace, memories, state.runs, concurrency)
      if (lifecycleToken !== runtimeMutableState.lifecycleToken) return
      const current = state.runs.get(namespace, name)
      if (
        typeof retryAt === 'number' &&
        current &&
        isQueuedRun(current) &&
        !readNested(current, ['metadata', 'deletionTimestamp'])
      ) {
        scheduleRunRetry(kube, namespace, name, state, concurrency, retryAt)
      } else {
        cancelRunRetry(namespace, name)
      }
    } catch (error) {
      if (!isKubeConflict(error)) throw error
      if (lifecycleToken !== runtimeMutableState.lifecycleToken) return
      // Retry from a new observation, never by attaching a fresh version to the rejected patch.
      const receipt = await readWhileWatchingRuns(state, namespace, async (changes) => {
        const refreshed = await kube.get(RESOURCE_MAP.AgentRun, name, namespace)
        if (lifecycleToken !== runtimeMutableState.lifecycleToken) return
        const current = state.runs.get(namespace, name)
        const order =
          refreshed && current
            ? compareResourceVersions(getResourceVersion(refreshed), getResourceVersion(current))
            : null
        const superseded = (order !== null && order < 0) || (changes.has(name) && (order === null || order <= 0))
        if (!superseded) {
          state.runs.update(namespace, name, refreshed)
          if (releasesRunCapacity(current, refreshed)) wakeCapacityWaiters(kube, state, concurrency)
        }
        // Keep a terminal receipt even if a deletion or replacement arrived during the read.
        if (
          refreshed &&
          (!isAgentRunTerminalPhase(asString(readNested(current, ['status', 'phase']))) ||
            readNested(refreshed, ['metadata', 'uid']) !== readNested(current, ['metadata', 'uid']))
        ) {
          return getTerminalIdempotencyReceipt(refreshed)
        }
      })
      if (lifecycleToken !== runtimeMutableState.lifecycleToken) return
      if (receipt) {
        void enqueueRun(kube, namespace, name, state, concurrency, { terminalReceipt: receipt })
      } else if (state.runs.get(namespace, name)) {
        scheduleRunRetry(kube, namespace, name, state, concurrency, Date.now() + RUN_CONFLICT_RETRY_MS)
      } else {
        cancelRunRetry(namespace, name)
      }
    }
  })
}

const getTerminalIdempotencyReceipt = (run: Record<string, unknown>) =>
  !readNested(run, ['metadata', 'deletionTimestamp']) &&
  isAgentRunTerminalPhase(asString(readNested(run, ['status', 'phase']))) &&
  isAgentRunIdempotencyEnabled() &&
  asString(readNested(run, ['spec', 'idempotencyKey']))
    ? run
    : undefined

const resyncAgentRunsForNamespace = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
  reason: 'periodic' | 'watch_restart' | 'manual',
) => {
  const lifecycleToken = runtimeMutableState.lifecycleToken
  const now = Date.now()
  const syncResult = await readWhileWatchingRuns(state, namespace, async (changes) => {
    const list = await kube.list(RESOURCE_MAP.AgentRun, namespace)
    if (lifecycleToken !== runtimeMutableState.lifecycleToken) return null
    const listVersion = getResourceVersion(list)
    const byName = new Map<string, Record<string, unknown>>()
    for (const run of listItems(list)) {
      const name = asString(readNested(run, ['metadata', 'name']))
      if (name) byName.set(name, run)
    }
    const changedNonTerminalRuns = new Set<string>()
    const terminalReceipts: Array<{ name: string; receipt: Record<string, unknown> }> = []
    let releasedCapacity = false
    for (const [name, run] of byName) {
      const previous = state.runs.get(namespace, name)
      const previousUid = asString(readNested(previous, ['metadata', 'uid']))
      const currentUid = asString(readNested(run, ['metadata', 'uid']))
      const sameObject = previous !== undefined && previousUid === currentUid
      const currentPhase = asString(readNested(run, ['status', 'phase']))
      if (releasesRunCapacity(previous, run)) releasedCapacity = true
      const receipt = getTerminalIdempotencyReceipt(run)
      if (receipt) {
        const wasTerminal = sameObject && isAgentRunTerminalPhase(asString(readNested(previous, ['status', 'phase'])))
        if (!wasTerminal) {
          terminalReceipts.push({ name, receipt })
        }
      } else if (
        currentPhase !== 'Template' &&
        !isAgentRunTerminalPhase(currentPhase) &&
        (!sameObject || getResourceVersion(previous) !== getResourceVersion(run))
      ) {
        // Relist observed a new or mutated non-terminal revision whose watch event will be covered by listVersion.
        changedNonTerminalRuns.add(name)
      }
    }
    // Only listed resources are eligible for this sweep. Defer any whose watch observation changed.
    await sweepExpiredAgentRunsForNamespace(kube, namespace, byName, now, reason, (name) => {
      const change = changes.get(name)
      return change !== undefined && !isCoveredByRunList(change.resource, listVersion)
    })
    if (lifecycleToken !== runtimeMutableState.lifecycleToken) return null
    for (const [name, change] of changes) {
      if (isCoveredByRunList(change.resource, listVersion)) continue
      if (change.deleted) byName.delete(name)
      else byName.set(name, change.resource)
    }
    ensureNamespaceState(state, namespace).runListVersion = listVersion
    state.runs.replaceNamespace(namespace, byName)
    return { refreshedRuns: byName, changedNonTerminalRuns, terminalReceipts, releasedCapacity }
  })
  if (!syncResult || lifecycleToken !== runtimeMutableState.lifecycleToken) return
  const { refreshedRuns, changedNonTerminalRuns, terminalReceipts, releasedCapacity } = syncResult
  const candidateRuns: Array<{ name: string; reasons: string[] }> = []
  const retryRuns: string[] = []
  let untouchedRunCount = 0
  let oldestUntouchedAgeSeconds: number | null = null
  let activeRuns = 0
  let queuedRuns = 0

  for (const [name, run] of refreshedRuns) {
    if (readNested(run, ['status', 'phase']) === 'Running') activeRuns += 1
    if (isQueuedRun(run)) queuedRuns += 1
    const reasons = getAgentRunUntouchedReasons(run)
    const untouchedReasons = reasons.filter((entry) => entry !== 'generation_drift')
    if (untouchedReasons.length > 0) {
      untouchedRunCount += 1
      const createdAtMs = getAgentRunCreationTimestampMs(run)
      if (createdAtMs !== null) {
        const ageSeconds = Math.max(0, Math.floor((now - createdAtMs) / 1000))
        oldestUntouchedAgeSeconds =
          oldestUntouchedAgeSeconds === null ? ageSeconds : Math.max(oldestUntouchedAgeSeconds, ageSeconds)
      }
    }
    const finalizers = readNested(run, ['metadata', 'finalizers'])
    const hasRuntimeFinalizer = Array.isArray(finalizers) && finalizers.includes('agents.proompteng.ai/runtime-cleanup')
    const workflowSteps = readNested(run, ['status', 'workflow', 'steps'])
    const hasPendingWorkflowStep =
      readNested(run, ['status', 'phase']) === 'Running' &&
      Array.isArray(workflowSteps) &&
      workflowSteps.some((step) => {
        const stepPhase = asString(readNested(step, ['phase']))
        return stepPhase === 'Pending' || stepPhase === 'Retrying'
      })
    if (reasons.length > 0) {
      candidateRuns.push({ name, reasons })
    } else if (
      changedNonTerminalRuns.has(name) ||
      (readNested(run, ['metadata', 'deletionTimestamp']) && hasRuntimeFinalizer) ||
      hasPendingWorkflowStep ||
      isQueuedRun(run)
    ) {
      // Relists may advance runListVersion past watch events for updated non-terminal runs,
      // deletions and pending/retrying workflow steps. Also retry queued runs, including those already owning a Job.
      retryRuns.push(name)
    }
  }

  const ingestionState = getAgentRunIngestionRuntimeState(namespace)
  ingestionState.lastResyncAtMs = now
  ingestionState.untouchedRunCount = untouchedRunCount
  ingestionState.oldestUntouchedAgeSeconds = oldestUntouchedAgeSeconds
  const warnAfterSeconds = resolveAgentRunUntouchedWarnAfterSeconds()
  const blindSinceStart = untouchedRunCount > 0 && ingestionState.lastWatchEventAtMs === null
  const stallSignature =
    (untouchedRunCount > 0 && oldestUntouchedAgeSeconds !== null && oldestUntouchedAgeSeconds >= warnAfterSeconds) ||
    blindSinceStart
      ? [untouchedRunCount, warnAfterSeconds, blindSinceStart ? 'blind' : 'seen'].join(':')
      : null
  if (stallSignature) {
    if (ingestionState.degradedSinceMs === null) {
      ingestionState.degradedSinceMs = now
    }
    ingestionState.healthyResyncStreak = 0
    if (ingestionState.lastStallSignature !== stallSignature) {
      logAgentsControllerWarn('agentrun_ingestion_stalled', {
        namespace,
        reason,
        untouchedRunCount,
        oldestUntouchedAgeSeconds,
        warnAfterSeconds,
        blindSinceStart,
      })
      ingestionState.lastStallSignature = stallSignature
    }
  } else {
    if (ingestionState.degradedSinceMs !== null) {
      ingestionState.healthyResyncStreak += 1
      if (ingestionState.healthyResyncStreak >= 2) {
        logAgentsControllerInfo('agentrun_ingestion_recovered', {
          namespace,
          reason,
          untouchedRunCount,
          oldestUntouchedAgeSeconds,
        })
        ingestionState.degradedSinceMs = null
        ingestionState.healthyResyncStreak = 0
        ingestionState.lastStallSignature = null
      }
    } else {
      ingestionState.healthyResyncStreak = 0
      ingestionState.lastStallSignature = null
    }
  }

  syncControllerAgentRunIngestionHealth()

  recordAgentConcurrency(activeRuns, { scope: 'namespace', namespace })
  recordAgentConcurrencyLimit(concurrency.perNamespace, { scope: 'namespace', namespace })
  recordAgentConcurrencyLimit(concurrency.cluster, { scope: 'cluster' })
  recordAgentQueueDepth(queuedRuns, { scope: 'namespace', namespace, source: 'snapshot' })
  recordAgentRunUntouchedBacklog(untouchedRunCount, { namespace })
  if (oldestUntouchedAgeSeconds !== null) {
    recordAgentRunUntouchedOldestAgeSeconds(oldestUntouchedAgeSeconds, { namespace, reason })
  }

  if (candidateRuns.length > 0) {
    recordAgentRunResyncAdoptions(candidateRuns.length, { namespace, reason })
  }

  const runtimeDebrisConfig = resolveRuntimeDebrisCleanupConfig()
  if (runtimeDebrisConfig.mode !== 'disabled') {
    try {
      const summary = await reconcileRuntimeDebris({
        config: runtimeDebrisConfig,
        kube,
        namespace,
      })
      if (lifecycleToken !== runtimeMutableState.lifecycleToken) return
      recordRuntimeDebrisOrphanPods(summary.orphanTerminalPods, { namespace, mode: summary.mode })
    } catch (error) {
      logAgentsControllerWarn('runtime_debris_reconcile_failed', {
        namespace,
        reason,
        ...toLogError(error),
      })
    }
  }

  const resyncSummarySignature = [
    refreshedRuns.size,
    candidateRuns.length,
    untouchedRunCount,
    oldestUntouchedAgeSeconds ?? 'none',
    blindSinceStart ? 'blind' : 'seen',
    ingestionState.healthyResyncStreak,
  ].join(':')
  const shouldLogResyncSummary =
    reason !== 'periodic' ||
    candidateRuns.length > 0 ||
    ingestionState.lastResyncSummarySignature !== resyncSummarySignature
  if (shouldLogResyncSummary) {
    logAgentsControllerInfo('agentrun_resync_completed', {
      namespace,
      reason,
      totalRuns: refreshedRuns.size,
      candidateCount: candidateRuns.length,
      untouchedRunCount,
      oldestUntouchedAgeSeconds,
      blindSinceStart,
      healthyResyncStreak: ingestionState.healthyResyncStreak,
    })
    ingestionState.lastResyncSummarySignature = resyncSummarySignature
  }

  for (const { name, reasons } of candidateRuns) {
    logAgentsControllerDebug('agentrun_resync_adopted', {
      namespace,
      runName: name,
      reason,
      adoptionReasons: reasons,
    })
    void enqueueRun(kube, namespace, name, state, concurrency)
  }
  for (const name of retryRuns) void enqueueRun(kube, namespace, name, state, concurrency)
  for (const { name, receipt } of terminalReceipts) {
    void enqueueRun(kube, namespace, name, state, concurrency, { terminalReceipt: receipt })
  }
  if (releasedCapacity) wakeCapacityWaiters(kube, state, concurrency)
}

const queueAgentRunResync = (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
  reason: 'periodic' | 'watch_restart' | 'manual',
) =>
  enqueueNamespaceTask(namespace, RUN_RESYNC, () =>
    resyncAgentRunsForNamespace(kube, namespace, state, concurrency, reason).catch((error) => {
      logAgentsControllerWarn('agentrun_resync_failed', {
        namespace,
        reason,
        ...toLogError(error),
      })
    }),
  )

const {
  reconcileAgent,
  reconcileAgentProvider,
  reconcileImplementationSpec,
  reconcileImplementationSource,
  reconcileVersionControlProvider,
  reconcileMemory,
} = createResourceReconcilers({
  setStatus: (kube, resource, status) => setStatus(kube as ReturnType<typeof createKubernetesClient>, resource, status),
  nowIso,
  implementationTextLimit: IMPLEMENTATION_TEXT_LIMIT,
  resolveVcsAuthMethod,
  validateVcsAuthConfig,
  parseIntOrString,
  resolveAuthSecretConfig,
  resolveSecretValue,
  secretHasKey,
  validateAutonomousCodexAuthSecret,
})

const buildConditions = (resource: Record<string, unknown>) =>
  normalizeConditions(readNested(resource, ['status', 'conditions']))

const { validateImplementationContract, buildContractStatus } = createImplementationContractTools(resolveParam)

const { submitCustomRun, submitTemporalRun, reconcileTemporalRun } = createTemporalRuntimeTools({
  getTemporalClient,
  resolveParameters,
  buildRunSpec,
  makeName,
  buildConditions,
  nowIso,
  setStatus: (kube, resource, status) =>
    setStatus(
      kube as unknown as ReturnType<typeof createKubernetesClient>,
      resource,
      status as Record<string, unknown>,
    ),
})

const { reconcileWorkflowRun } = createWorkflowReconciler({
  resolveRunnerServiceAccount,
  resolveJobImage,
  validateImplementationContract,
  buildContractStatus,
  buildConditions,
  setStatus,
  nowIso,
  submitJobRun,
  applyJobTtlAfterStatus,
  normalizeLabelValue,
  verifyJobConfigMaps,
  isJobComplete,
  isJobFailed,
})

const { reconcileAgentRun, recordTerminalIdempotency } = createAgentRunReconciler({
  setStatus,
  nowIso,
  isKubeNotFoundError,
  resolveJobImage,
  getAgentRunRetentionDecision,
  getPrimitivesStore,
  getTemporalClient,
  reconcileWorkflowRun,
  submitJobRun,
  submitCustomRun,
  submitTemporalRun,
  reconcileTemporalRun,
  buildConditions,
  isAgentRunImmutabilityEnforced,
  isAgentRunIdempotencyEnabled,
  parseQueueLimits,
  parseRateLimits,
  getControllerRateState: () => runtimeMutableState.controllerRateState,
  validateImplementationContract,
  buildContractStatus,
  resolveRunnerServiceAccount,
  applyJobTtlAfterStatus,
  verifyJobConfigMaps,
  isJobComplete,
  isJobFailed,
  recordAgentQueueDepth,
  recordAgentRateLimitRejection,
})

const reconcileAgentRunWithMetrics = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  namespace: string,
  memories: Record<string, unknown>[],
  runs: AgentRunIndex,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const reconcileStartedAt = Date.now()
  try {
    return await reconcileAgentRun(kube, agentRun, namespace, memories, runs, concurrency)
  } finally {
    const durationMs = Date.now() - reconcileStartedAt
    recordReconcileDurationMs(durationMs, { kind: 'agentrun', namespace })
  }
}

const reconcileNamespaceState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const lifecycleToken = runtimeMutableState.lifecycleToken
  const { agents, providers, specs, sources, vcsProviders, memories } = snapshotNamespace(
    ensureNamespaceState(state, namespace),
  )
  const runs = state.runs.list(namespace)

  for (const memory of memories) {
    await reconcileMemory(kube, memory, namespace)
  }

  for (const provider of providers) {
    await reconcileAgentProvider(kube, provider, agents, runs)
  }

  for (const agent of agents) {
    await reconcileAgent(kube, agent, namespace, providers, memories)
  }

  for (const spec of specs) {
    await reconcileImplementationSpec(kube, spec)
  }

  for (const source of sources) {
    await reconcileImplementationSource(kube, source, namespace)
  }

  if (isVcsProvidersEnabled()) {
    for (const vcsProvider of vcsProviders) {
      await reconcileVersionControlProvider(kube, vcsProvider, namespace)
    }
  }

  if (lifecycleToken !== runtimeMutableState.lifecycleToken) return
  for (const run of runs) {
    const name = asString(readNested(run, ['metadata', 'name']))
    if (!name) continue
    const terminalReceipt = getTerminalIdempotencyReceipt(run)
    void enqueueRun(kube, namespace, name, state, concurrency, terminalReceipt ? { terminalReceipt } : undefined)
  }
}

const _reconcileAll = async (
  kube: ReturnType<typeof createKubernetesClient>,
  state: ControllerState,
  namespaces: string[],
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  if (runtimeMutableState.reconciling) return
  runtimeMutableState.reconciling = true
  try {
    if (isAgentRunIdempotencyEnabled()) {
      const now = Date.now()
      if (now - runtimeMutableState.lastIdempotencyPruneAtMs >= 60 * 60 * 1000) {
        const store = await getPrimitivesStore()
        if (store) {
          try {
            const retentionDays = resolveAgentRunIdempotencyRetentionDays()
            await store.pruneAgentRunIdempotencyKeys(retentionDays)
            runtimeMutableState.lastIdempotencyPruneAtMs = now
          } catch (error) {
            console.warn('[agents] failed to prune AgentRun idempotency keys', error)
          }
        }
      }
    }
    for (const namespace of namespaces) {
      await reconcileNamespaceState(kube, namespace, state, concurrency)
    }
  } catch (error) {
    console.warn('[agents] agents controller failed', error)
  } finally {
    runtimeMutableState.reconciling = false
  }
}

const seedNamespaceState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
) => {
  const nsState = ensureNamespaceState(state, namespace)
  const memoryList = await kube.list(RESOURCE_MAP.Memory, namespace)
  const agentList = await kube.list(RESOURCE_MAP.Agent, namespace)
  const specList = await kube.list(RESOURCE_MAP.ImplementationSpec, namespace)
  const sourceList = await kube.list(RESOURCE_MAP.ImplementationSource, namespace)
  const vcsProviderList = isVcsProvidersEnabled()
    ? await kube.list(RESOURCE_MAP.VersionControlProvider, namespace)
    : null
  const providerList = await kube.list(RESOURCE_MAP.AgentProvider, namespace)
  const runList = await kube.list(RESOURCE_MAP.AgentRun, namespace)
  const memories = listItems(memoryList)
  const agents = listItems(agentList)
  const specs = listItems(specList)
  const sources = listItems(sourceList)
  const vcsProviders = vcsProviderList ? listItems(vcsProviderList) : []
  const providers = listItems(providerList)
  const runs = listItems(runList)

  for (const resource of memories) updateStateMap(nsState.memories, 'ADDED', resource)
  for (const resource of agents) updateStateMap(nsState.agents, 'ADDED', resource)
  for (const resource of specs) updateStateMap(nsState.specs, 'ADDED', resource)
  for (const resource of sources) updateStateMap(nsState.sources, 'ADDED', resource)
  for (const resource of vcsProviders) updateStateMap(nsState.vcsProviders, 'ADDED', resource)
  for (const resource of providers) updateStateMap(nsState.providers, 'ADDED', resource)
  for (const run of runs) {
    const name = asString(readNested(run, ['metadata', 'name']))
    if (name) state.runs.update(namespace, name, run)
  }

  return {
    agentRunResourceVersion: getResourceVersion(runList),
  }
}

const startNamespaceWatches = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
  handles: Array<{ stop: () => void }>,
  options?: { agentRunResourceVersion?: string | null },
) => {
  const nsState = ensureNamespaceState(state, namespace)
  nsState.runListVersion = options?.agentRunResourceVersion ?? null
  const enqueueFull = () =>
    enqueueNamespaceTask(namespace, DEPENDENCY_RECONCILE, () =>
      reconcileNamespaceState(kube, namespace, state, concurrency),
    )

  const handleAgentRunEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const runName = asString(readNested(resource, ['metadata', 'name']))
    if (!runName) return
    recordAgentRunWatchEventSeen(namespace)
    logAgentsControllerDebug('agentrun_watch_event_seen', {
      namespace,
      runName,
      eventType: event.type ?? 'UNKNOWN',
    })
    if (isCoveredByRunList(resource, nsState.runListVersion)) return
    const deleted = event.type === 'DELETED'
    const previous = state.runs.get(namespace, runName)
    if (previous) {
      const order = compareResourceVersions(getResourceVersion(resource), getResourceVersion(previous))
      if (order !== null && order < 0) return
    }
    nsState.runChangesDuringRead?.set(runName, { resource, deleted })
    const next = deleted ? null : resource
    state.runs.update(namespace, runName, next)
    if (!next || !isQueuedRun(next) || readNested(next, ['metadata', 'deletionTimestamp'])) {
      cancelRunRetry(namespace, runName)
    }
    if (releasesRunCapacity(previous, next)) wakeCapacityWaiters(kube, state, concurrency)
    if (deleted) return
    const terminalReceipt = getTerminalIdempotencyReceipt(resource)
    void enqueueRun(kube, namespace, runName, state, concurrency, { terminalReceipt })
  }

  const handleAgentEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const shouldReconcile = shouldDependencyEventTriggerFullReconcile(nsState.agents, event.type, resource)
    updateStateMap(nsState.agents, event.type, resource)
    if (shouldReconcile) void enqueueFull()
  }

  const handleProviderEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const shouldReconcile = shouldDependencyEventTriggerFullReconcile(nsState.providers, event.type, resource)
    updateStateMap(nsState.providers, event.type, resource)
    if (shouldReconcile) void enqueueFull()
  }

  const handleSpecEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const shouldReconcile = shouldDependencyEventTriggerFullReconcile(nsState.specs, event.type, resource)
    updateStateMap(nsState.specs, event.type, resource)
    if (shouldReconcile) void enqueueFull()
  }

  const handleSourceEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const shouldReconcile = shouldDependencyEventTriggerFullReconcile(nsState.sources, event.type, resource)
    updateStateMap(nsState.sources, event.type, resource)
    if (shouldReconcile) void enqueueFull()
  }

  const handleVcsProviderEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const shouldReconcile = shouldDependencyEventTriggerFullReconcile(nsState.vcsProviders, event.type, resource)
    updateStateMap(nsState.vcsProviders, event.type, resource)
    if (shouldReconcile) void enqueueFull()
  }

  const handleMemoryEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const shouldReconcile = shouldDependencyEventTriggerFullReconcile(nsState.memories, event.type, resource)
    updateStateMap(nsState.memories, event.type, resource)
    if (shouldReconcile) void enqueueFull()
  }

  const handleJobEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const runName = asString(readNested(resource, ['metadata', 'labels', 'agents.proompteng.ai/agent-run']))
    if (!runName) return
    void enqueueRun(kube, namespace, runName, state, concurrency, { lookupMissing: true })
  }

  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.AgentRun,
      namespace,
      resourceVersion: options?.agentRunResourceVersion ?? undefined,
      onEvent: handleAgentRunEvent,
      onError: (error) =>
        logAgentsControllerWarn('agentrun_watch_failed', {
          namespace,
          ...toLogError(error),
        }),
      onRestart: (restartReason) => {
        if (restartReason === 'closed') {
          logAgentsControllerDebug('agentrun_watch_restarted', {
            namespace,
            reason: restartReason,
          })
          return
        }
        logAgentsControllerWarn('agentrun_watch_restarted', {
          namespace,
          reason: restartReason,
        })
        queueAgentRunResync(kube, namespace, state, concurrency, 'watch_restart')
      },
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.Agent,
      namespace,
      onEvent: handleAgentEvent,
      onError: (error) => console.warn('[agents] agent watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.AgentProvider,
      namespace,
      onEvent: handleProviderEvent,
      onError: (error) => console.warn('[agents] provider watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.ImplementationSpec,
      namespace,
      onEvent: handleSpecEvent,
      onError: (error) => console.warn('[agents] implementation spec watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.ImplementationSource,
      namespace,
      onEvent: handleSourceEvent,
      onError: (error) => console.warn('[agents] implementation source watch failed', error),
    }),
  )
  if (isVcsProvidersEnabled()) {
    handles.push(
      startResourceWatch({
        resource: RESOURCE_MAP.VersionControlProvider,
        namespace,
        onEvent: handleVcsProviderEvent,
        onError: (error) => console.warn('[agents] vcs provider watch failed', error),
      }),
    )
  }
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.Memory,
      namespace,
      onEvent: handleMemoryEvent,
      onError: (error) => console.warn('[agents] memory watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: 'job',
      namespace,
      labelSelector: 'agents.proompteng.ai/agent-run',
      onEvent: handleJobEvent,
      onError: (error) => console.warn('[agents] agent job watch failed', error),
    }),
  )

  const resyncInterval = resolveAgentRunResyncIntervalSeconds() * 1000
  const timer = setInterval(() => {
    queueAgentRunResync(kube, namespace, state, concurrency, 'periodic')
  }, resyncInterval)
  handles.push({
    stop: () => clearInterval(timer),
  })

  // The initial resync can be large in production. Watches are already live here, so run it
  // in the background instead of blocking controller startup and readiness.
  void enqueueFull()
  void queueAgentRunResync(kube, namespace, state, concurrency, 'manual')
}

const stopWatchHandles = (handles: Array<{ stop: () => void }>) => {
  for (const handle of handles) {
    handle.stop()
  }
}

const startAgentsControllerInternal = async () => {
  const startAccepted = requestAgentsControllerStart(runtimeMutableState.lifecycleActor)
  if (!startAccepted) return
  runtimeMutableState.starting = true
  runtimeMutableState.started = false
  runtimeMutableState.lifecycleToken += 1
  const token = runtimeMutableState.lifecycleToken
  let featureEnabled = false
  try {
    featureEnabled = await shouldStartWithFeatureFlag()
  } catch (error) {
    if (runtimeMutableState.lifecycleToken === token) {
      runtimeMutableState.starting = false
      markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    }
    throw error
  }
  if (!featureEnabled) {
    if (runtimeMutableState.lifecycleToken === token) {
      runtimeMutableState.starting = false
      markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    }
    return
  }
  const kubeGateway = createKubeGateway()
  let crdsReady: CrdCheckState
  try {
    crdsReady = await checkCrds({
      resolveRequiredCrds,
      resolveCrdCheckNamespace,
      resolveNatsDependency,
      nowIso,
      kubeGateway,
    })
    runtimeMutableState.crdCheckState = crdsReady
    controllerState.crdCheckState = crdsReady
  } catch (error) {
    logAgentsControllerError('startup_namespace_scope_failed', toLogError(error))
    runtimeMutableState.starting = false
    markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    if (error instanceof Error && error.name === 'NamespaceScopeConfigError') {
      process.exitCode = 1
    }
    throw error
  }
  if (!crdsReady.ok) {
    logAgentsControllerError('startup_missing_crds', {
      missingCrds: crdsReady.missing,
      forbiddenCrds: crdsReady.forbidden,
    })
    runtimeMutableState.starting = false
    markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    return
  }
  const handles: Array<{ stop: () => void }> = []
  let startupCommitted = false
  try {
    const namespaces = await resolveNamespaces(kubeGateway)
    if (runtimeMutableState.lifecycleToken !== token) return
    controllerState.namespaces = namespaces
    logAgentsControllerInfo('startup_namespace_scope', { namespaces })
    const kube = createKubernetesClient()
    const concurrency = parseConcurrency()
    const state = createControllerState()
    const namespaceSeedResults = new Map<string, { agentRunResourceVersion: string | null }>()
    for (const namespace of namespaces) {
      namespaceSeedResults.set(namespace, await seedNamespaceState(kube, namespace, state))
      if (runtimeMutableState.lifecycleToken !== token) return
    }
    for (const namespace of namespaces) {
      await startNamespaceWatches(kube, namespace, state, concurrency, handles, namespaceSeedResults.get(namespace))
      if (runtimeMutableState.lifecycleToken !== token) return
    }
    if (runtimeMutableState.lifecycleToken !== token) return
    runtimeMutableState.watchHandles = handles
    runtimeMutableState.controllerSnapshot = state
    runtimeMutableState.started = true
    startupCommitted = true
    markAgentsControllerStarted(runtimeMutableState.lifecycleActor)
    controllerState.started = true
    syncControllerAgentRunIngestionHealth()
    logAgentsControllerInfo('startup_complete', { namespaces })
  } catch (error) {
    logAgentsControllerError('startup_failed', toLogError(error))
    if (runtimeMutableState.lifecycleToken === token) {
      markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    }
    if (error instanceof Error && error.name === 'NamespaceScopeConfigError') {
      process.exitCode = 1
      throw error
    }
  } finally {
    if (!startupCommitted) {
      stopWatchHandles(handles)
    }
    if (runtimeMutableState.lifecycleToken === token) {
      runtimeMutableState.starting = false
      if (!runtimeMutableState.started) {
        markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
      }
    }
  }
}

const stopAgentsControllerInternal = () => {
  requestAgentsControllerStop(runtimeMutableState.lifecycleActor)
  runtimeMutableState.lifecycleToken += 1
  runtimeMutableState.starting = false
  stopWatchHandles(runtimeMutableState.watchHandles)
  runtimeMutableState.watchHandles = []
  runtimeMutableState.controllerSnapshot = null
  runtimeMutableState.namespaceQueues.clear()
  for (const { timer } of runtimeMutableState.runRetries.values()) clearTimeout(timer)
  runtimeMutableState.runRetries.clear()
  runtimeMutableState.agentRunIngestionState.clear()
  clearAgentsControllerGauges()
  runtimeMutableState.started = false
  controllerState.started = false
  controllerState.namespaces = null
  controllerState.agentRunIngestion = []
}

export type AgentsControllerService = {
  start: Effect.Effect<void, Error>
  stop: Effect.Effect<void, never>
  getHealth: Effect.Effect<AgentsControllerHealth, never>
}

export class AgentsController extends Context.Service<AgentsController, AgentsControllerService>()(
  'AgentsController',
) {}

export const AgentsControllerLive = Layer.effect(
  AgentsController,
  Effect.gen(function* () {
    initializeRuntimeMutableStateForLayer()
    yield* Effect.addFinalizer(() => Effect.sync(() => stopAgentsControllerInternal()))
    return {
      start: Effect.tryPromise({
        try: () => startAgentsControllerInternal(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
      stop: Effect.sync(() => {
        stopAgentsControllerInternal()
      }),
      getHealth: Effect.sync(() => getAgentsControllerHealth()),
    } satisfies AgentsControllerService
  }),
)

const agentsControllerRuntime = ManagedRuntime.make(AgentsControllerLive)

export const startAgentsControllerEffect = Effect.flatMap(AgentsController, (service) => service.start)
export const stopAgentsControllerEffect = Effect.flatMap(AgentsController, (service) => service.stop)
export const getAgentsControllerHealthEffect = Effect.flatMap(AgentsController, (service) => service.getHealth)

export const runAgentsControllerEffect = <A, E>(effect: Effect.Effect<A, E, AgentsController>): Promise<A> =>
  agentsControllerRuntime.runPromise(effect)

export const startAgentsController = async () => {
  await startAgentsControllerInternal()
}

export const stopAgentsController = () => {
  stopAgentsControllerInternal()
}

export const __test = {
  initializeRuntimeMutableStateForLayer,
  getRuntimeMutableState: () => runtimeMutableState,
  checkCrds,
  clearGithubAppTokenCache,
  resetControllerRateState,
  fetchGithubAppToken,
  setStatus,
  resolveAgentRunArtifactsLimitConfig,
  limitAgentRunStatusArtifacts,
  buildArtifactsLimitMessage,
  resolveAgentsControllerFeatureEnabled: shouldStartWithFeatureFlag,
  reconcileAgentRun: reconcileAgentRunWithMetrics,
  reconcileVersionControlProvider,
  reconcileMemory,
  resolveVcsPrRateLimits,
  resolveJobImage,
  resolveVcsContext,
  shouldDependencyEventTriggerFullReconcile,
  getAgentRunRetentionDecision,
  getAgentRunUntouchedReasons,
  resyncAgentRunsForNamespace: async (...args: Parameters<typeof queueAgentRunResync>) => {
    await queueAgentRunResync(...args)
    await runtimeMutableState.namespaceQueues.get(args[1])?.tail
  },
  startNamespaceWatches,
  syncControllerAgentRunIngestionHealth,
  assessAgentRunIngestion,
  stopWatchHandles,
}
