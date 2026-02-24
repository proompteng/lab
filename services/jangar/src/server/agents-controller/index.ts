import { createTemporalClient, loadTemporalConfig } from '@proompteng/temporal-bun-sdk'
import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import { startResourceWatch } from '~/server/kube-watch'
import { recordAgentConcurrency, recordAgentRunOutcome, recordReconcileDurationMs } from '~/server/metrics'
import { parseNamespaceScopeEnv } from '~/server/namespace-scope'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { createPrimitivesStore } from '~/server/primitives-store'
import { shouldApplyStatus } from '~/server/status-utils'
import { createAgentRunReconciler } from './agent-run-reconciler'
import {
  buildArtifactsLimitMessage,
  limitAgentRunStatusArtifacts,
  resolveAgentRunArtifactsLimitConfig,
} from './agentrun-artifacts'
import { deriveStandardConditionUpdates, normalizeConditions, upsertCondition } from './conditions'
import { checkCrds, parseConcurrency, parseQueueLimits, parseRateLimits, runKubectl } from './controller-config'
import { parseBooleanEnv, parseNumberEnv, parseOptionalNumber } from './env-config'
import { createImplementationContractTools } from './implementation-contract'
import {
  applyJobTtlAfterStatus,
  buildRunSpec,
  makeName,
  normalizeLabelValue,
  resolveRunnerServiceAccount,
  submitJobRun,
} from './job-runtime'
import {
  markAgentsControllerStarted,
  markAgentsControllerStartFailed,
  requestAgentsControllerStart,
  requestAgentsControllerStop,
} from './lifecycle-machine'
import { type AgentsControllerMutableState, type CrdCheckState, createMutableState } from './mutable-state'
import {
  type ControllerState,
  ensureNamespaceState,
  listItems,
  snapshotNamespace,
  updateStateMap,
} from './namespace-state'
import { buildInFlightCounts } from './queue-state'
import { resetControllerRateState as resetControllerRateStateMaps } from './rate-limits'
import { createResourceReconcilers } from './resource-reconcilers'
import { resolveParam, resolveParameters } from './run-utils'
import { createTemporalRuntimeTools } from './temporal-runtime'
import { resolveVcsAuthMethod, validateVcsAuthConfig } from './vcs-auth'
import {
  clearGithubAppTokenCache,
  fetchGithubAppToken,
  parseIntOrString,
  resolveVcsContext,
  resolveVcsPrRateLimits,
  secretHasKey,
} from './vcs-context'
import { createWorkflowReconciler } from './workflow-reconciler'

const DEFAULT_NAMESPACES = ['agents']
const DEFAULT_AGENTRUN_RETENTION_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const IMPLEMENTATION_TEXT_LIMIT = 128 * 1024
const DEFAULT_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS = 30
const DEFAULT_AGENTS_CONTROLLER_ENABLED_FLAG_KEY = 'jangar.agents_controller.enabled'

const BASE_REQUIRED_CRDS = [
  'agents.agents.proompteng.ai',
  'agentruns.agents.proompteng.ai',
  'agentproviders.agents.proompteng.ai',
  'implementationspecs.agents.proompteng.ai',
  'implementationsources.agents.proompteng.ai',
  'memories.agents.proompteng.ai',
]
const VCS_PROVIDER_CRD = 'versioncontrolproviders.agents.proompteng.ai'

const isVcsProvidersEnabled = () => parseBooleanEnv(process.env.JANGAR_AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED, true)

const isAgentRunImmutabilityEnforced = () => parseBooleanEnv(process.env.JANGAR_AGENTRUN_IMMUTABILITY_ENFORCED, true)

const resolveRequiredCrds = () => {
  if (!isVcsProvidersEnabled()) return BASE_REQUIRED_CRDS
  return [...BASE_REQUIRED_CRDS.slice(0, 5), VCS_PROVIDER_CRD, ...BASE_REQUIRED_CRDS.slice(5)]
}

type ControllerHealthState = {
  started: boolean
  crdCheckState: CrdCheckState | null
  namespaces: string[] | null
}

const globalState = globalThis as typeof globalThis & {
  __jangarAgentsControllerState?: ControllerHealthState
}

const controllerState = (() => {
  if (globalState.__jangarAgentsControllerState) return globalState.__jangarAgentsControllerState
  const initial = { started: false, crdCheckState: null, namespaces: null }
  globalState.__jangarAgentsControllerState = initial
  return initial
})()

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
  if (process.env.NODE_ENV === 'test') return false
  return parseBooleanEnv(process.env.JANGAR_AGENTS_CONTROLLER_ENABLED, true)
}

const shouldStartWithFeatureFlag = async () => {
  if (process.env.NODE_ENV === 'test') return false
  return resolveBooleanFeatureToggle({
    key: DEFAULT_AGENTS_CONTROLLER_ENABLED_FLAG_KEY,
    keyEnvVar: 'JANGAR_AGENTS_CONTROLLER_ENABLED_FLAG_KEY',
    fallbackEnvVar: 'JANGAR_AGENTS_CONTROLLER_ENABLED',
    defaultValue: true,
  })
}

const parseNamespaces = () => {
  return parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
    fallback: DEFAULT_NAMESPACES,
    label: 'agents controller',
  })
}

const resolveCrdCheckNamespace = () => {
  const namespaces = parseNamespaces()
  if (namespaces.includes('*')) return 'default'
  return namespaces[0] ?? 'default'
}

const resolveNamespaces = async () => {
  const namespaces = parseNamespaces()
  if (!namespaces.includes('*')) {
    return namespaces
  }
  const result = await runKubectl(['get', 'namespace', '-o', 'json'])
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to list namespaces')
  }
  const payload = JSON.parse(result.stdout) as Record<string, unknown>
  const items = Array.isArray(payload.items) ? payload.items : []
  const resolved = items
    .map((item) => {
      const metadata = item && typeof item === 'object' ? (item as Record<string, unknown>).metadata : null
      const name = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).name : null
      return typeof name === 'string' ? name : null
    })
    .filter((value): value is string => Boolean(value))
  if (resolved.length === 0) {
    throw new Error('no namespaces returned by kubectl')
  }
  return resolved
}

export const getAgentsControllerHealth = () => ({
  enabled: shouldStart(),
  started: controllerState.started,
  namespaces: controllerState.namespaces,
  crdsReady: controllerState.crdCheckState?.ok ?? null,
  missingCrds: controllerState.crdCheckState?.missing ?? [],
  lastCheckedAt: controllerState.crdCheckState?.checkedAt ?? null,
})

const isAgentRunIdempotencyEnabled = () => parseBooleanEnv(process.env.JANGAR_AGENTRUN_IDEMPOTENCY_ENABLED, true)

const resolveAgentRunIdempotencyRetentionDays = () =>
  parseNumberEnv(process.env.JANGAR_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS, DEFAULT_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS, 1)

const getPrimitivesStore = async () => {
  if (runtimeMutableState.primitivesStoreRef) return runtimeMutableState.primitivesStoreRef
  try {
    runtimeMutableState.primitivesStoreRef = createPrimitivesStore()
    await runtimeMutableState.primitivesStoreRef.ready
    return runtimeMutableState.primitivesStoreRef
  } catch (error) {
    runtimeMutableState.primitivesStoreRef = null
    console.warn('[jangar] failed to initialize primitives store (idempotency disabled)', error)
    return null
  }
}

const setStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
  status: Record<string, unknown>,
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
  const nextStatus = {
    ...nextStatusBase,
    updatedAt: nowIso(),
    conditions,
  }
  if (!shouldApplyStatus(asRecord(resource.status), nextStatus)) {
    return
  }
  if (kind === 'AgentRun') {
    const previousPhase = asString(asRecord(resource.status)?.phase)
    const nextPhase = asString(nextStatusBase.phase)
    if (nextPhase && ['Succeeded', 'Failed', 'Cancelled'].includes(nextPhase) && previousPhase !== nextPhase) {
      const runtimeRef = asRecord(status.runtimeRef) ?? asRecord(readNested(resource, ['status', 'runtimeRef'])) ?? {}
      const runtimeType =
        asString(runtimeRef.type) ?? asString(readNested(resource, ['spec', 'runtime', 'type'])) ?? 'unknown'
      recordAgentRunOutcome(nextPhase, { runtime: runtimeType })
    }
  }
  await kube.applyStatus({ apiVersion, kind, metadata: { name, namespace }, status: nextStatus })
}

const resolveJobImage = (workload: Record<string, unknown>) =>
  asString(workload.image) ?? process.env.JANGAR_AGENT_RUNNER_IMAGE ?? process.env.JANGAR_AGENT_IMAGE ?? null

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
  const parsed = parseOptionalNumber(process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS)
  if (parsed === undefined || parsed < 0) return DEFAULT_AGENTRUN_RETENTION_SECONDS
  return Math.floor(parsed)
}

const resolveAgentRunRetentionSeconds = (spec: Record<string, unknown>) => {
  const override = parseOptionalNumber(spec.ttlSecondsAfterFinished)
  if (override !== undefined && override >= 0) return Math.floor(override)
  return parseAgentRunRetentionSeconds()
}

const resetControllerRateState = () => {
  resetControllerRateStateMaps(runtimeMutableState.controllerRateState)
}

const enqueueNamespaceTask = (namespace: string, task: () => Promise<void>) => {
  const current = runtimeMutableState.namespaceQueues.get(namespace) ?? Promise.resolve()
  const next = current
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      console.warn('[jangar] agents controller task failed', error)
    })
  runtimeMutableState.namespaceQueues.set(namespace, next)
}

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
  secretHasKey,
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
  isJobComplete,
  isJobFailed,
})

const { reconcileAgentRun } = createAgentRunReconciler({
  setStatus,
  nowIso,
  isKubeNotFoundError,
  resolveJobImage,
  resolveAgentRunRetentionSeconds,
  getPrimitivesStore,
  runKubectl,
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
  getControllerSnapshot: () => runtimeMutableState.controllerSnapshot,
  getControllerRateState: () => runtimeMutableState.controllerRateState,
  validateImplementationContract,
  buildContractStatus,
  resolveRunnerServiceAccount,
  applyJobTtlAfterStatus,
  isJobComplete,
  isJobFailed,
})

const reconcileAgentRunWithMetrics = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  namespace: string,
  memories: Record<string, unknown>[],
  existingRuns: Record<string, unknown>[],
  concurrency: ReturnType<typeof parseConcurrency>,
  inFlight: { total: number; perAgent: Map<string, number>; perRepository: Map<string, number> },
  globalInFlight: number,
) => {
  const reconcileStartedAt = Date.now()
  try {
    await reconcileAgentRun(kube, agentRun, namespace, memories, existingRuns, concurrency, inFlight, globalInFlight)
  } finally {
    const durationMs = Date.now() - reconcileStartedAt
    recordReconcileDurationMs(durationMs, { kind: 'agentrun', namespace })
  }
}

const reconcileNamespaceSnapshot = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  snapshot: ReturnType<typeof snapshotNamespace>,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const { agents, providers, specs, sources, vcsProviders, memories, runs } = snapshot

  for (const memory of memories) {
    await reconcileMemory(kube, memory, namespace)
  }

  for (const agent of agents) {
    await reconcileAgent(kube, agent, namespace, providers, memories)
  }

  for (const provider of providers) {
    await reconcileAgentProvider(kube, provider)
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

  const counts = buildInFlightCounts(state, namespace)
  const inFlight = {
    total: counts.total,
    perAgent: counts.perAgent,
    perRepository: counts.perRepository,
  }
  recordAgentConcurrency(counts.total, { scope: 'namespace', namespace })
  recordAgentConcurrency(counts.cluster, { scope: 'cluster' })

  for (const run of runs) {
    await reconcileAgentRunWithMetrics(kube, run, namespace, memories, runs, concurrency, inFlight, counts.cluster)
  }
}

const reconcileRunWithState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  run: Record<string, unknown>,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const snapshot = snapshotNamespace(ensureNamespaceState(state, namespace))
  const counts = buildInFlightCounts(state, namespace)
  const inFlight = {
    total: counts.total,
    perAgent: counts.perAgent,
    perRepository: counts.perRepository,
  }
  await reconcileAgentRunWithMetrics(
    kube,
    run,
    namespace,
    snapshot.memories,
    snapshot.runs,
    concurrency,
    inFlight,
    counts.cluster,
  )
}

const reconcileNamespaceState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const snapshot = snapshotNamespace(ensureNamespaceState(state, namespace))
  await reconcileNamespaceSnapshot(kube, namespace, snapshot, state, concurrency)
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
            console.warn('[jangar] failed to prune AgentRun idempotency keys', error)
          }
        }
      }
    }
    for (const namespace of namespaces) {
      await reconcileNamespaceState(kube, namespace, state, concurrency)
    }
  } catch (error) {
    console.warn('[jangar] agents controller failed', error)
  } finally {
    runtimeMutableState.reconciling = false
  }
}

const seedNamespaceState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const nsState = ensureNamespaceState(state, namespace)
  const memories = listItems(await kube.list(RESOURCE_MAP.Memory, namespace))
  const agents = listItems(await kube.list(RESOURCE_MAP.Agent, namespace))
  const specs = listItems(await kube.list(RESOURCE_MAP.ImplementationSpec, namespace))
  const sources = listItems(await kube.list(RESOURCE_MAP.ImplementationSource, namespace))
  const vcsProviders = isVcsProvidersEnabled()
    ? listItems(await kube.list(RESOURCE_MAP.VersionControlProvider, namespace))
    : []
  const providers = listItems(await kube.list(RESOURCE_MAP.AgentProvider, namespace))
  const runs = listItems(await kube.list(RESOURCE_MAP.AgentRun, namespace))

  for (const resource of memories) updateStateMap(nsState.memories, 'ADDED', resource)
  for (const resource of agents) updateStateMap(nsState.agents, 'ADDED', resource)
  for (const resource of specs) updateStateMap(nsState.specs, 'ADDED', resource)
  for (const resource of sources) updateStateMap(nsState.sources, 'ADDED', resource)
  for (const resource of vcsProviders) updateStateMap(nsState.vcsProviders, 'ADDED', resource)
  for (const resource of providers) updateStateMap(nsState.providers, 'ADDED', resource)
  for (const resource of runs) updateStateMap(nsState.runs, 'ADDED', resource)

  enqueueNamespaceTask(namespace, () =>
    reconcileNamespaceSnapshot(kube, namespace, snapshotNamespace(nsState), state, concurrency),
  )
}

const startNamespaceWatches = (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
  handles: Array<{ stop: () => void }>,
) => {
  const nsState = ensureNamespaceState(state, namespace)
  const enqueueFull = () =>
    enqueueNamespaceTask(namespace, () => reconcileNamespaceState(kube, namespace, state, concurrency))

  const handleAgentRunEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.runs, event.type, resource)
    if (event.type === 'DELETED') return
    enqueueNamespaceTask(namespace, () => reconcileRunWithState(kube, namespace, resource, state, concurrency))
  }

  const handleAgentEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.agents, event.type, resource)
    enqueueFull()
  }

  const handleProviderEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.providers, event.type, resource)
    enqueueFull()
  }

  const handleSpecEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.specs, event.type, resource)
    enqueueFull()
  }

  const handleSourceEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.sources, event.type, resource)
    enqueueFull()
  }

  const handleVcsProviderEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.vcsProviders, event.type, resource)
    enqueueFull()
  }

  const handleMemoryEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.memories, event.type, resource)
    enqueueFull()
  }

  const handleJobEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const runName = asString(readNested(resource, ['metadata', 'labels', 'agents.proompteng.ai/agent-run']))
    if (!runName) return
    enqueueNamespaceTask(namespace, async () => {
      const existing = nsState.runs.get(runName)
      const run = existing ?? (await kube.get(RESOURCE_MAP.AgentRun, runName, namespace))
      if (!run) return
      nsState.runs.set(runName, run)
      await reconcileRunWithState(kube, namespace, run, state, concurrency)
    })
  }

  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.AgentRun,
      namespace,
      onEvent: handleAgentRunEvent,
      onError: (error) => console.warn('[jangar] agent run watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.Agent,
      namespace,
      onEvent: handleAgentEvent,
      onError: (error) => console.warn('[jangar] agent watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.AgentProvider,
      namespace,
      onEvent: handleProviderEvent,
      onError: (error) => console.warn('[jangar] provider watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.ImplementationSpec,
      namespace,
      onEvent: handleSpecEvent,
      onError: (error) => console.warn('[jangar] implementation spec watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.ImplementationSource,
      namespace,
      onEvent: handleSourceEvent,
      onError: (error) => console.warn('[jangar] implementation source watch failed', error),
    }),
  )
  if (isVcsProvidersEnabled()) {
    handles.push(
      startResourceWatch({
        resource: RESOURCE_MAP.VersionControlProvider,
        namespace,
        onEvent: handleVcsProviderEvent,
        onError: (error) => console.warn('[jangar] vcs provider watch failed', error),
      }),
    )
  }
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.Memory,
      namespace,
      onEvent: handleMemoryEvent,
      onError: (error) => console.warn('[jangar] memory watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: 'job',
      namespace,
      labelSelector: 'agents.proompteng.ai/agent-run',
      onEvent: handleJobEvent,
      onError: (error) => console.warn('[jangar] agent job watch failed', error),
    }),
  )
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
  let crdsReady: CrdCheckState
  try {
    crdsReady = await checkCrds({
      resolveRequiredCrds,
      resolveCrdCheckNamespace,
      nowIso,
    })
  } catch (error) {
    console.error('[jangar] agents controller failed to validate namespace scope', error)
    runtimeMutableState.starting = false
    markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    if (error instanceof Error && error.name === 'NamespaceScopeConfigError') {
      process.exitCode = 1
    }
    throw error
  }
  if (!crdsReady.ok) {
    console.error('[jangar] agents controller will not start without CRDs')
    runtimeMutableState.starting = false
    markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    return
  }
  const handles: Array<{ stop: () => void }> = []
  try {
    const namespaces = await resolveNamespaces()
    if (runtimeMutableState.lifecycleToken !== token) return
    controllerState.namespaces = namespaces
    console.info('[jangar] agents controller namespace scope:', JSON.stringify(namespaces))
    const kube = createKubernetesClient()
    const concurrency = parseConcurrency()
    const state: ControllerState = { namespaces: new Map() }
    for (const namespace of namespaces) {
      await seedNamespaceState(kube, namespace, state, concurrency)
      if (runtimeMutableState.lifecycleToken !== token) return
    }
    for (const namespace of namespaces) {
      startNamespaceWatches(kube, namespace, state, concurrency, handles)
      if (runtimeMutableState.lifecycleToken !== token) return
    }
    if (runtimeMutableState.lifecycleToken !== token) return
    runtimeMutableState.watchHandles = handles
    runtimeMutableState.controllerSnapshot = state
    runtimeMutableState.started = true
    markAgentsControllerStarted(runtimeMutableState.lifecycleActor)
    controllerState.started = true
  } catch (error) {
    console.error('[jangar] agents controller failed to start', error)
    if (runtimeMutableState.lifecycleToken === token) {
      markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    }
    if (error instanceof Error && error.name === 'NamespaceScopeConfigError') {
      process.exitCode = 1
      throw error
    }
  } finally {
    if (runtimeMutableState.lifecycleToken !== token) {
      for (const handle of handles) {
        handle.stop()
      }
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
  for (const handle of runtimeMutableState.watchHandles) {
    handle.stop()
  }
  runtimeMutableState.watchHandles = []
  runtimeMutableState.controllerSnapshot = null
  runtimeMutableState.namespaceQueues.clear()
  runtimeMutableState.started = false
  controllerState.started = false
  controllerState.namespaces = null
}

export type AgentsControllerHealth = ReturnType<typeof getAgentsControllerHealth>

export type AgentsControllerService = {
  start: Effect.Effect<void, Error>
  stop: Effect.Effect<void, never>
  getHealth: Effect.Effect<AgentsControllerHealth, never>
}

export class AgentsController extends Context.Tag('AgentsController')<AgentsController, AgentsControllerService>() {}

export const AgentsControllerLive = Layer.scoped(
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
  reconcileAgentRun: reconcileAgentRunWithMetrics,
  reconcileVersionControlProvider,
  reconcileMemory,
  resolveVcsPrRateLimits,
  resolveJobImage,
  resolveVcsContext,
}
