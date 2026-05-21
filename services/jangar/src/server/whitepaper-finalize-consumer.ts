import {
  ackAgentRunTerminalEventViaAgentsService,
  fetchAgentRunTerminalEventsFromAgentsService,
  type AgentsAgentRunTerminalEvent,
  type AgentsAgentRunTerminalEventAckInput,
} from '@proompteng/agent-contracts'
import { resolveWhitepaperControlConfig } from '~/server/whitepaper-config'
import { maybeFinalizeWhitepaperRun, type WhitepaperFinalizeTerminalStatusInput } from '~/server/whitepaper-finalize'

const DEFAULT_NAMESPACE = 'agents'
const WHITEPAPER_FINALIZE_CONSUMER = 'whitepaper-finalize'

type WhitepaperFinalizeConsumerState = {
  started: boolean
  intervals: Array<ReturnType<typeof setInterval>>
  inFlight: Set<string>
  completed: Set<string>
  namespaces: string[]
  scanIntervalMs: number | null
}

type ListTerminalEvents = (namespace: string) => Promise<AgentsAgentRunTerminalEvent[]>
type AckTerminalEvent = (input: AgentsAgentRunTerminalEventAckInput) => Promise<void>

type WhitepaperFinalizeConsumerDeps = {
  listTerminalEvents?: ListTerminalEvents
  ackTerminalEvent?: AckTerminalEvent
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

const processTerminalEvent = async (
  state: WhitepaperFinalizeConsumerState,
  ackTerminalEvent: AckTerminalEvent,
  event: AgentsAgentRunTerminalEvent,
  finalize: (input: WhitepaperFinalizeTerminalStatusInput) => Promise<void>,
) => {
  const runId = event.runId?.trim() ?? ''
  if (!runId.startsWith('wp-')) return
  if (event.acked) return

  const key = event.eventId
  if (state.completed.has(key)) return
  if (state.inFlight.has(key)) return

  state.inFlight.add(key)
  try {
    await finalize({
      resource: event.resource,
      nextStatus: event.status,
      previousPhase: null,
      nextPhase: event.phase,
    })
    await ackTerminalEvent({
      eventId: event.eventId,
      consumer: WHITEPAPER_FINALIZE_CONSUMER,
      outcome: 'finalized',
      message: `Finalized whitepaper run ${runId}`,
    })
    state.completed.add(key)
  } catch (error) {
    console.warn('[jangar][whitepaper-finalize-consumer] failed to finalize terminal AgentRun event', {
      eventId: event.eventId,
      runName: event.name,
      runId,
      phase: event.phase,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    state.inFlight.delete(key)
  }
}

const listTerminalEventsFromAgentsService: ListTerminalEvents = async (namespace) => {
  const result = await fetchAgentRunTerminalEventsFromAgentsService({
    namespace,
    runIdPrefix: 'wp-',
    consumer: WHITEPAPER_FINALIZE_CONSUMER,
    limit: 500,
  })
  if (!result.ok) {
    throw new Error(
      `Agents service AgentRun terminal event list failed (${result.status}): ${result.error ?? 'unknown error'}`,
    )
  }
  return result.body.events
}

const ackTerminalEventThroughAgentsService: AckTerminalEvent = async (input) => {
  const result = await ackAgentRunTerminalEventViaAgentsService(input)
  if (!result.ok) {
    throw new Error(
      `Agents service AgentRun terminal event ack failed (${result.status}): ${result.error ?? 'unknown error'}`,
    )
  }
}

const scanNamespace = async (
  state: WhitepaperFinalizeConsumerState,
  listTerminalEvents: ListTerminalEvents,
  ackTerminalEvent: AckTerminalEvent,
  namespace: string,
  finalize: (input: WhitepaperFinalizeTerminalStatusInput) => Promise<void>,
) => {
  try {
    const events = await listTerminalEvents(namespace)
    for (const event of events) {
      await processTerminalEvent(state, ackTerminalEvent, event, finalize)
    }
  } catch (error) {
    console.warn('[jangar][whitepaper-finalize-consumer] failed to scan terminal AgentRun events', {
      namespace,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export const startWhitepaperFinalizeConsumer = (deps: WhitepaperFinalizeConsumerDeps = {}) => {
  const state = getState()
  if (state.started) return
  if (!shouldStart()) return

  const listTerminalEvents = deps.listTerminalEvents ?? listTerminalEventsFromAgentsService
  const ackTerminalEvent = deps.ackTerminalEvent ?? ackTerminalEventThroughAgentsService
  const finalize = deps.finalize ?? maybeFinalizeWhitepaperRun
  const namespaces = resolveNamespaces()
  const scanIntervalMs = resolveScanIntervalMs()

  state.started = true
  state.namespaces = namespaces
  state.scanIntervalMs = scanIntervalMs

  for (const namespace of namespaces) {
    const scan = () => void scanNamespace(state, listTerminalEvents, ackTerminalEvent, namespace, finalize)
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
    mode: 'agents-terminal-events',
    namespaces: state.namespaces,
    inFlight: state.inFlight.size,
    scanIntervalMs: state.scanIntervalMs,
  }
}
