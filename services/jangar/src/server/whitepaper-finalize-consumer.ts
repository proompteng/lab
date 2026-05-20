import {
  fetchAgentRunResourcesFromAgentsService,
  patchAgentRunAnnotationsViaAgentsService,
  type AgentsAgentRunAnnotationsPatchInput,
} from '@proompteng/agent-contracts/agents-service-client'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { resolveWhitepaperControlConfig } from '~/server/whitepaper-config'
import { maybeFinalizeWhitepaperRun, type WhitepaperFinalizeTerminalStatusInput } from '~/server/whitepaper-finalize'

const FINALIZED_PHASE_ANNOTATION = 'jangar.proompteng.ai/whitepaper-finalized-phase'
const FINALIZED_RUN_ID_ANNOTATION = 'jangar.proompteng.ai/whitepaper-finalized-run-id'
const FINALIZED_AT_ANNOTATION = 'jangar.proompteng.ai/whitepaper-finalized-at'
const DEFAULT_NAMESPACE = 'agents'

type WhitepaperFinalizeConsumerState = {
  started: boolean
  intervals: Array<ReturnType<typeof setInterval>>
  inFlight: Set<string>
  completed: Set<string>
  namespaces: string[]
  scanIntervalMs: number | null
}

type ListAgentRuns = (namespace: string) => Promise<Record<string, unknown>[]>
type PatchAgentRunAnnotations = (input: AgentsAgentRunAnnotationsPatchInput) => Promise<void>

type WhitepaperFinalizeConsumerDeps = {
  listAgentRuns?: ListAgentRuns
  patchAgentRunAnnotations?: PatchAgentRunAnnotations
  finalize?: (input: WhitepaperFinalizeTerminalStatusInput) => Promise<void>
}

const globalState = globalThis as typeof globalThis & {
  __jangarWhitepaperFinalizeConsumer?: WhitepaperFinalizeConsumerState
}

const getState = (): WhitepaperFinalizeConsumerState => {
  if (!globalState.__jangarWhitepaperFinalizeConsumer) {
    globalState.__jangarWhitepaperFinalizeConsumer = {
      started: false,
      intervals: [],
      inFlight: new Set<string>(),
      completed: new Set<string>(),
      namespaces: [],
      scanIntervalMs: null,
    }
  }
  return globalState.__jangarWhitepaperFinalizeConsumer
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const resolveNamespaces = (env: Record<string, string | undefined> = process.env) => {
  const raw = env.JANGAR_WHITEPAPER_FINALIZE_NAMESPACES ?? DEFAULT_NAMESPACE
  const namespaces = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry, index, list) => entry.length > 0 && list.indexOf(entry) === index)
  return namespaces.length > 0 ? namespaces : [DEFAULT_NAMESPACE]
}

const shouldStart = (env: Record<string, string | undefined> = process.env) =>
  resolveWhitepaperControlConfig(env).enabled && parseBoolean(env.JANGAR_WHITEPAPER_FINALIZE_CONSUMER_ENABLED, true)

const resolveScanIntervalMs = (env: Record<string, string | undefined> = process.env) => {
  const parsed = Number(env.JANGAR_WHITEPAPER_FINALIZE_SCAN_INTERVAL_MS)
  if (!Number.isFinite(parsed) || parsed <= 0) return 30_000
  return Math.max(5_000, Math.min(Math.trunc(parsed), 300_000))
}

const isTerminalPhase = (phase: string | null) => phase === 'Succeeded' || phase === 'Failed' || phase === 'Cancelled'

const getMetadata = (resource: Record<string, unknown>) => asRecord(resource.metadata) ?? {}

const getAnnotations = (resource: Record<string, unknown>) => asRecord(getMetadata(resource).annotations) ?? {}

const getRunId = (resource: Record<string, unknown>) => {
  const parameters = asRecord(readNested(resource, ['spec', 'parameters'])) ?? {}
  return asString(parameters.runId)?.trim() || asString(parameters.run_id)?.trim() || ''
}

const wasFinalized = (resource: Record<string, unknown>, runId: string, phase: string) => {
  const annotations = getAnnotations(resource)
  return annotations[FINALIZED_RUN_ID_ANNOTATION] === runId && annotations[FINALIZED_PHASE_ANNOTATION] === phase
}

const patchFinalizedAnnotations = async (
  patchAgentRunAnnotations: PatchAgentRunAnnotations,
  resource: Record<string, unknown>,
  runId: string,
  phase: string,
) => {
  const metadata = getMetadata(resource)
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace) ?? DEFAULT_NAMESPACE
  if (!name) return

  await patchAgentRunAnnotations({
    name,
    namespace,
    annotations: {
      [FINALIZED_PHASE_ANNOTATION]: phase,
      [FINALIZED_RUN_ID_ANNOTATION]: runId,
      [FINALIZED_AT_ANNOTATION]: new Date().toISOString(),
    },
  })
}

const buildProcessKey = (resource: Record<string, unknown>, phase: string) => {
  const metadata = getMetadata(resource)
  const namespace = asString(metadata.namespace) ?? DEFAULT_NAMESPACE
  const name = asString(metadata.name) ?? 'unknown'
  const uid = asString(metadata.uid) ?? name
  return `${namespace}/${name}/${uid}/${phase}`
}

const processAgentRun = async (
  state: WhitepaperFinalizeConsumerState,
  patchAgentRunAnnotations: PatchAgentRunAnnotations,
  resource: Record<string, unknown>,
  finalize: (input: WhitepaperFinalizeTerminalStatusInput) => Promise<void>,
) => {
  const status = asRecord(resource.status) ?? {}
  const phase = asString(status.phase) ?? null
  if (!isTerminalPhase(phase)) return

  const runId = getRunId(resource)
  if (!runId.startsWith('wp-')) return
  if (wasFinalized(resource, runId, phase)) return

  const key = buildProcessKey(resource, phase)
  if (state.completed.has(key)) return
  if (state.inFlight.has(key)) return

  state.inFlight.add(key)
  try {
    await finalize({
      resource,
      nextStatus: status,
      previousPhase: null,
      nextPhase: phase,
    })
    await patchFinalizedAnnotations(patchAgentRunAnnotations, resource, runId, phase)
    state.completed.add(key)
  } catch (error) {
    console.warn('[jangar][whitepaper-finalize-consumer] failed to finalize AgentRun', {
      runName: asString(readNested(resource, ['metadata', 'name'])) ?? null,
      runId,
      phase,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    state.inFlight.delete(key)
  }
}

const listItems = (payload: Record<string, unknown>) => {
  const items = Array.isArray(payload.items) ? payload.items : []
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

const listAgentRunsFromAgentsService: ListAgentRuns = async (namespace) => {
  const result = await fetchAgentRunResourcesFromAgentsService({ namespace, limit: 500 })
  if (!result.ok) {
    throw new Error(
      `Agents service AgentRun resource list failed (${result.status}): ${result.error ?? 'unknown error'}`,
    )
  }
  return listItems(asRecord(result.body) ?? {})
}

const patchAgentRunAnnotationsThroughAgentsService: PatchAgentRunAnnotations = async (input) => {
  const result = await patchAgentRunAnnotationsViaAgentsService(input)
  if (!result.ok) {
    throw new Error(
      `Agents service AgentRun annotation patch failed (${result.status}): ${result.error ?? 'unknown error'}`,
    )
  }
}

const scanNamespace = async (
  state: WhitepaperFinalizeConsumerState,
  listAgentRuns: ListAgentRuns,
  patchAgentRunAnnotations: PatchAgentRunAnnotations,
  namespace: string,
  finalize: (input: WhitepaperFinalizeTerminalStatusInput) => Promise<void>,
) => {
  try {
    const items = await listAgentRuns(namespace)
    for (const item of items) {
      await processAgentRun(state, patchAgentRunAnnotations, item, finalize)
    }
  } catch (error) {
    console.warn('[jangar][whitepaper-finalize-consumer] failed to scan AgentRuns', {
      namespace,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export const startWhitepaperFinalizeConsumer = (deps: WhitepaperFinalizeConsumerDeps = {}) => {
  const state = getState()
  if (state.started) return
  if (!shouldStart()) return

  const listAgentRuns = deps.listAgentRuns ?? listAgentRunsFromAgentsService
  const patchAgentRunAnnotations = deps.patchAgentRunAnnotations ?? patchAgentRunAnnotationsThroughAgentsService
  const finalize = deps.finalize ?? maybeFinalizeWhitepaperRun
  const namespaces = resolveNamespaces()
  const scanIntervalMs = resolveScanIntervalMs()

  state.started = true
  state.namespaces = namespaces
  state.scanIntervalMs = scanIntervalMs

  for (const namespace of namespaces) {
    const scan = () => void scanNamespace(state, listAgentRuns, patchAgentRunAnnotations, namespace, finalize)
    scan()
    const interval = setInterval(scan, scanIntervalMs)
    const maybeNodeInterval = interval as ReturnType<typeof setInterval> & { unref?: () => void }
    maybeNodeInterval.unref?.()
    state.intervals.push(interval)
  }
}

export const stopWhitepaperFinalizeConsumer = () => {
  const state = getState()
  for (const interval of state.intervals.splice(0)) {
    clearInterval(interval)
  }
  state.inFlight.clear()
  state.completed.clear()
  state.started = false
  state.namespaces = []
  state.scanIntervalMs = null
}

export const getWhitepaperFinalizeConsumerHealth = () => {
  const state = getState()
  return {
    enabled: shouldStart(),
    started: state.started,
    mode: 'agents-service-poll',
    namespaces: state.namespaces,
    inFlight: state.inFlight.size,
    scanIntervalMs: state.scanIntervalMs,
  }
}
