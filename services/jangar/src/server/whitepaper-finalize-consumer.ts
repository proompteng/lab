import { startResourceWatch, type WatchHandle, type WatchOptions } from '~/server/kube-watch'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP, type KubernetesClient } from '~/server/primitives-kube'
import { resolveWhitepaperControlConfig } from '~/server/whitepaper-config'
import { maybeFinalizeWhitepaperRun, type WhitepaperFinalizeTerminalStatusInput } from '~/server/whitepaper-finalize'

const FINALIZED_PHASE_ANNOTATION = 'jangar.proompteng.ai/whitepaper-finalized-phase'
const FINALIZED_RUN_ID_ANNOTATION = 'jangar.proompteng.ai/whitepaper-finalized-run-id'
const FINALIZED_AT_ANNOTATION = 'jangar.proompteng.ai/whitepaper-finalized-at'
const DEFAULT_NAMESPACE = 'agents'

type WhitepaperFinalizeConsumerState = {
  started: boolean
  handles: WatchHandle[]
  inFlight: Set<string>
  namespaces: string[]
}

type WhitepaperFinalizeConsumerDeps = {
  kube?: KubernetesClient
  startWatch?: (options: WatchOptions) => WatchHandle
  finalize?: (input: WhitepaperFinalizeTerminalStatusInput) => Promise<void>
}

const globalState = globalThis as typeof globalThis & {
  __jangarWhitepaperFinalizeConsumer?: WhitepaperFinalizeConsumerState
}

const getState = (): WhitepaperFinalizeConsumerState => {
  if (!globalState.__jangarWhitepaperFinalizeConsumer) {
    globalState.__jangarWhitepaperFinalizeConsumer = {
      started: false,
      handles: [],
      inFlight: new Set<string>(),
      namespaces: [],
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
  const raw = env.JANGAR_WHITEPAPER_FINALIZE_NAMESPACES ?? env.AGENTS_NAMESPACE ?? DEFAULT_NAMESPACE
  const namespaces = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry, index, list) => entry.length > 0 && list.indexOf(entry) === index)
  return namespaces.length > 0 ? namespaces : [DEFAULT_NAMESPACE]
}

const shouldStart = (env: Record<string, string | undefined> = process.env) =>
  resolveWhitepaperControlConfig(env).enabled && parseBoolean(env.JANGAR_WHITEPAPER_FINALIZE_CONSUMER_ENABLED, true)

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
  kube: Pick<KubernetesClient, 'patch'>,
  resource: Record<string, unknown>,
  runId: string,
  phase: string,
) => {
  const metadata = getMetadata(resource)
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace) ?? DEFAULT_NAMESPACE
  if (!name) return

  await kube.patch(RESOURCE_MAP.AgentRun, name, namespace, {
    metadata: {
      annotations: {
        ...getAnnotations(resource),
        [FINALIZED_PHASE_ANNOTATION]: phase,
        [FINALIZED_RUN_ID_ANNOTATION]: runId,
        [FINALIZED_AT_ANNOTATION]: new Date().toISOString(),
      },
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
  kube: KubernetesClient,
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
  if (state.inFlight.has(key)) return

  state.inFlight.add(key)
  try {
    await finalize({
      resource,
      nextStatus: status,
      previousPhase: null,
      nextPhase: phase,
    })
    await patchFinalizedAnnotations(kube, resource, runId, phase)
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

const scanNamespace = async (
  state: WhitepaperFinalizeConsumerState,
  kube: KubernetesClient,
  namespace: string,
  finalize: (input: WhitepaperFinalizeTerminalStatusInput) => Promise<void>,
) => {
  try {
    const payload = await kube.list(RESOURCE_MAP.AgentRun, namespace)
    for (const item of listItems(payload)) {
      await processAgentRun(state, kube, item, finalize)
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

  const kube = deps.kube ?? createKubernetesClient()
  const startWatch = deps.startWatch ?? startResourceWatch
  const finalize = deps.finalize ?? maybeFinalizeWhitepaperRun
  const namespaces = resolveNamespaces()

  state.started = true
  state.namespaces = namespaces

  for (const namespace of namespaces) {
    void scanNamespace(state, kube, namespace, finalize)
    state.handles.push(
      startWatch({
        resource: RESOURCE_MAP.AgentRun,
        namespace,
        onEvent: (event) => {
          if (event.type === 'DELETED') return
          const resource = asRecord(event.object)
          if (!resource) return
          void processAgentRun(state, kube, resource, finalize)
        },
        onError: (error) => console.warn('[jangar][whitepaper-finalize-consumer] AgentRun watch failed', error),
      }),
    )
  }
}

export const stopWhitepaperFinalizeConsumer = () => {
  const state = getState()
  for (const handle of state.handles.splice(0)) {
    handle.stop()
  }
  state.inFlight.clear()
  state.started = false
  state.namespaces = []
}

export const getWhitepaperFinalizeConsumerHealth = () => {
  const state = getState()
  return {
    enabled: shouldStart(),
    started: state.started,
    namespaces: state.namespaces,
    inFlight: state.inFlight.size,
  }
}
