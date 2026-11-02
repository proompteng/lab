import { putS3Object, resolveArtifactUploadConfig } from '../artifact-storage'

import { runnerQuotaSchema, runnerUsageSchema, runnerTelemetryKey, type RunnerTelemetry } from '../runner-telemetry'

import { isRecord } from './spec'

type Notification = { method: string; params?: unknown }
type Tool = RunnerTelemetry['activeTools'][number]
type Options = {
  model?: string
  effort?: string
  now?: () => Date
  podName?: string
  publish?: (snapshot: RunnerTelemetry) => Promise<void>
  write: (line: string) => void
}

const record = (value: unknown) => (isRecord(value) ? value : {})
const text = (value: unknown, limit = 256) => (typeof value === 'string' ? value.slice(0, limit) : '')
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
  let pending = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  const current: RunnerTelemetry = {
    version: 1,
    state: 'starting',
    startedAt,
    heartbeatAt: startedAt,
    lastActivityAt: null,
    podName: options.podName ?? null,
    model: options.model ?? null,
    effort: options.effort ?? null,
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
    options.write(`${JSON.stringify({ ts: now().toISOString(), event })}\n`)
  const flush = () => {
    pending = pending.then(async () => {
      current.heartbeatAt = now().toISOString()
      const value = snapshot()
      emit({ type: 'heartbeat', telemetry: value })
      try {
        await options.publish?.(value)
      } catch (error) {
        current.publishErrors += 1
        emit({ type: 'telemetry_error', message: text(error instanceof Error ? error.message : String(error), 640) })
      }
    })
    return pending
  }
  const observe = ({ method, params: raw }: Notification) => {
    if (closed) return
    const params = record(raw)
    const thread = text(params.threadId) || text(record(params.thread).id)
    if (thread && current.threadId && thread !== current.threadId) return
    if (thread) current.threadId = thread
    const turn = text(params.turnId) || text(record(params.turn).id)
    if (turn) current.turnId = turn
    const at = now().toISOString()
    switch (method) {
      case 'turn/started':
        active.clear()
        streamedOutput.clear()
        current.state = 'running'
        current.lastActivityAt = at
        emit({ type: 'turn_started', threadId: current.threadId, turnId: current.turnId })
        break
      case 'turn/completed':
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
        const kind = toolKind(item.type)
        if (!kind) return
        const id = text(item.id)
        if (!id) return
        const title = text(item.command) || text(item.tool) || kind
        current.lastActivityAt = at
        if (method === 'item/started') active.set(id, { id, kind, title, startedAt: at })
        else active.delete(id)
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
        emit({
          type: 'tool',
          id,
          kind,
          title,
          status: method === 'item/started' ? 'started' : 'completed',
          ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
          ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
          ...(output && !streamedOutput.has(id)
            ? { output: output.slice(0, 65536), outputTruncated: output.length > 65536 }
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
        emit({ type: 'output', id, delta: delta.slice(0, 65536), truncated: delta.length > 65536 })
        break
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (!delta) return
        current.lastActivityAt = at
        emit({
          type: method === 'item/agentMessage/delta' ? 'message' : 'reasoning',
          delta: delta.slice(0, 65536),
          truncated: delta.length > 65536,
        })
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
        current.quota = parsed.data
        emit({ type: 'quota', quota: current.quota })
        break
      }
      case 'error':
        current.lastActivityAt = at
        emit({ type: 'error', message: text(record(params.error).message, 640) })
        break
    }
  }
  return {
    observe,
    snapshot,
    flush,
    start: () => {
      timer = setInterval(() => void flush(), 10_000)
      timer.unref()
      return flush()
    },
    finish: async () => {
      closed = true
      if (timer) clearInterval(timer)
      active.clear()
      current.state = 'finished'
      await flush()
      return snapshot()
    },
  }
}

export const createTelemetryPublisher = (env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) => {
  const namespace = env.AGENT_RUN_NAMESPACE
  const uid = env.AGENT_RUN_UID
  if (!namespace || !uid) return undefined
  return async (snapshot: RunnerTelemetry) => {
    const config = resolveArtifactUploadConfig(env)
    if (!config) return
    await putS3Object({
      config,
      key: runnerTelemetryKey(namespace, uid),
      body: Buffer.from(JSON.stringify(snapshot)),
      fetch: fetchImpl,
      now: new Date(),
      timeoutMs: 5000,
    })
  }
}
