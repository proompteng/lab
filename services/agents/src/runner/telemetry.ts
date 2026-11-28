import { putS3Object, resolveArtifactUploadConfig } from '../artifact-storage'

import { runnerQuotaSchema, runnerUsageSchema, runnerTelemetryKey, type RunnerTelemetry } from '../runner-telemetry'

import { redactCredentials, runnerErrorMessage, stringifyRunnerOutput } from './redact'
import { waitWithSignal } from './shutdown'
import { isRecord } from './spec'

const HEARTBEAT_INTERVAL_MS = 30_000
const TELEMETRY_PUT_TIMEOUT_MS = 8_000
const MAX_DELTA_CHARS = 65_536

type Notification = { method: string; params?: unknown }
type Tool = RunnerTelemetry['activeTools'][number]
type DeltaType = 'output' | 'message' | 'reasoning'
type Options = {
  model?: string
  effort?: string
  now?: () => Date
  podName?: string
  heartbeatIntervalMs?: number
  publish?: (snapshot: RunnerTelemetry, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
  write: (line: string) => void
}

const record = (value: unknown) => (isRecord(value) ? value : {})
const text = (value: unknown, limit = 256) =>
  typeof value === 'string' ? redactCredentials(value).slice(0, limit) : ''
const toolKind = (value: unknown): Tool['kind'] | null => {
  switch (value) {
    case 'commandExecution':
    case 'mcpToolCall':
    case 'fileChange':
    case 'webSearch':
    case 'dynamicToolCall':
      return value
    default:
      return null
  }
}

export const createRunnerTelemetry = (options: Options) => {
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const active = new Map<string, Tool>()
  const streamedOutput = new Set<string>()
  const pending = new Map<string, { type: DeltaType; id: string; carry: string; skipLine: boolean }>()
  let inFlight: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let completion: Promise<RunnerTelemetry> | undefined
  const current: RunnerTelemetry = {
    version: 1,
    state: 'starting',
    startedAt,
    heartbeatAt: startedAt,
    lastActivityAt: null,
    podName: options.podName ? redactCredentials(options.podName) : null,
    model: options.model ? redactCredentials(options.model) : null,
    effort: options.effort ? redactCredentials(options.effort) : null,
    threadId: null,
    turnId: null,
    activeTools: [],
    activeToolCount: 0,
    usage: null,
    quota: null,
    publishErrors: 0,
  }
  const snapshot = (): RunnerTelemetry => ({
    ...current,
    activeTools: [...active.values()].slice(0, 8),
    activeToolCount: active.size,
  })
  const emit = (event: Record<string, unknown>) =>
    options.write(`${stringifyRunnerOutput({ ts: now().toISOString(), event })}\n`)
  const emitDelta = (type: DeltaType, id: string, value: string, truncated = false) => {
    const safe = redactCredentials(value)
    emit({
      type,
      ...(type === 'output' ? { id } : {}),
      delta: safe.slice(0, MAX_DELTA_CHARS),
      truncated: truncated || safe.length > MAX_DELTA_CHARS,
    })
  }
  const flushDeltas = (id?: string) => {
    for (const [key, delta] of pending) {
      if (id !== undefined && id !== delta.id) continue
      if (delta.carry) emitDelta(delta.type, delta.id, delta.carry)
      pending.delete(key)
    }
  }
  const observeDelta = (type: DeltaType, id: string, value: string) => {
    // Credentials can span notifications. Emit complete lines, or the tail at item/turn completion.
    const key = `${type}:${id}`
    const delta = pending.get(key) ?? { type, id, carry: '', skipLine: false }
    if (delta.skipLine) {
      const newline = value.indexOf('\n')
      if (newline === -1) return
      delta.skipLine = false
      value = value.slice(newline + 1)
    }
    const combined = delta.carry + value
    const end = combined.lastIndexOf('\n') + 1
    if (end) emitDelta(type, id, combined.slice(0, end))
    delta.carry = combined.slice(end)
    if (delta.carry.length > MAX_DELTA_CHARS) {
      emitDelta(type, id, '', true)
      delta.carry = ''
      delta.skipLine = true
    }
    if (delta.carry || delta.skipLine) pending.set(key, delta)
    else pending.delete(key)
  }
  const recordPublishError = (error: unknown) => {
    current.publishErrors += 1
    emit({ type: 'telemetry_error', message: runnerErrorMessage(error).slice(0, 640) })
  }
  const publish = async (value: RunnerTelemetry, signal?: AbortSignal) => {
    try {
      await options.publish?.(value, signal)
    } catch (error) {
      if (!signal?.aborted) recordPublishError(error)
    }
  }
  const emitHeartbeat = () => {
    current.heartbeatAt = now().toISOString()
    const value = snapshot()
    emit({ type: 'heartbeat', telemetry: value })
    return value
  }
  const flush = () => {
    if (completion || options.signal?.aborted) return
    const value = emitHeartbeat()
    inFlight ??= publish(value, options.signal).finally(() => {
      inFlight = undefined
    })
    return inFlight
  }
  const observe = ({ method, params: raw }: Notification) => {
    if (completion) return
    const params = record(raw)
    const thread = text(params.threadId) || text(record(params.thread).id)
    if (thread && current.threadId && thread !== current.threadId) return
    if (thread) current.threadId = thread
    const turn = text(params.turnId) || text(record(params.turn).id)
    if (turn) current.turnId = turn
    const at = now().toISOString()
    switch (method) {
      case 'turn/started':
        flushDeltas()
        active.clear()
        streamedOutput.clear()
        current.state = 'running'
        current.lastActivityAt = at
        emit({ type: 'turn_started', threadId: current.threadId, turnId: current.turnId })
        break
      case 'turn/completed':
        flushDeltas()
        active.clear()
        current.lastActivityAt = at
        emit({
          type: 'turn_completed',
          threadId: current.threadId,
          turnId: current.turnId,
          status: record(params.turn).status,
        })
        break
      case 'item/started':
      case 'item/completed': {
        const item = record(params.item)
        const id = text(item.id)
        if (!id) return
        if (method === 'item/completed') flushDeltas(id)
        const kind = toolKind(item.type)
        if (!kind) return
        const title = text(item.command) || text(item.tool) || kind
        current.lastActivityAt = at
        if (method === 'item/started') active.set(id, { id, kind, title, startedAt: at })
        else active.delete(id)
        const output = typeof item.aggregatedOutput === 'string' ? redactCredentials(item.aggregatedOutput) : ''
        emit({
          type: 'tool',
          id,
          kind,
          title,
          status: method === 'item/started' ? 'started' : 'completed',
          ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
          ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
          ...(output && !streamedOutput.has(id)
            ? { output: output.slice(0, MAX_DELTA_CHARS), outputTruncated: output.length > MAX_DELTA_CHARS }
            : {}),
        })
        break
      }
      case 'item/commandExecution/outputDelta': {
        const id = text(params.itemId)
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (!delta) return
        current.lastActivityAt = at
        if (id) streamedOutput.add(id)
        observeDelta('output', id, delta)
        break
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (!delta) return
        current.lastActivityAt = at
        observeDelta(method === 'item/agentMessage/delta' ? 'message' : 'reasoning', text(params.itemId), delta)
        break
      }
      case 'thread/tokenUsage/updated': {
        const parsed = runnerUsageSchema.safeParse(record(params.tokenUsage).total)
        if (!parsed.success) {
          emit({ type: 'telemetry_error', message: 'invalid token usage notification' })
          return
        }
        current.usage = parsed.data
        current.lastActivityAt = at
        emit({ type: 'usage', usage: current.usage })
        break
      }
      case 'account/rateLimits/updated': {
        const parsed = runnerQuotaSchema.safeParse(params.rateLimits)
        if (!parsed.success) {
          emit({ type: 'telemetry_error', message: 'invalid rate-limit notification' })
          return
        }
        current.quota = {
          ...parsed.data,
          limitId: parsed.data.limitId === null ? null : text(parsed.data.limitId),
          limitName: parsed.data.limitName === null ? null : text(parsed.data.limitName),
        }
        emit({ type: 'quota', quota: current.quota })
        break
      }
      case 'error':
        current.lastActivityAt = at
        emit({ type: 'error', message: text(record(params.error).message, 640) })
        break
    }
  }
  const finish = async (signal?: AbortSignal) => {
    if (timer) clearInterval(timer)
    flushDeltas()
    active.clear()
    current.state = 'finished'
    emitHeartbeat()
    try {
      // Drain the active PUT before publishing the terminal snapshot; the local heartbeat never waits for S3.
      if (inFlight) await waitWithSignal(inFlight, signal)
      signal?.throwIfAborted()
      await waitWithSignal(publish(snapshot(), signal), signal)
    } catch (error) {
      recordPublishError(error)
    }
    return snapshot()
  }
  return {
    observe,
    snapshot,
    flush,
    start: () => {
      if (!timer && !completion) {
        timer = setInterval(() => void flush(), options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
        timer.unref()
      }
      return flush()
    },
    finish: (signal?: AbortSignal) => (completion ??= finish(signal)),
  }
}

export const createTelemetryPublisher = (env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) => {
  const namespace = env.AGENT_RUN_NAMESPACE
  const uid = env.AGENT_RUN_UID
  if (!namespace || !uid) return undefined
  return async (snapshot: RunnerTelemetry, signal?: AbortSignal) => {
    const config = resolveArtifactUploadConfig(env)
    if (!config) return
    await putS3Object({
      config,
      key: runnerTelemetryKey(namespace, uid),
      body: Buffer.from(stringifyRunnerOutput(snapshot)),
      fetch: fetchImpl,
      now: new Date(),
      timeoutMs: TELEMETRY_PUT_TIMEOUT_MS,
      signal,
    })
  }
}
