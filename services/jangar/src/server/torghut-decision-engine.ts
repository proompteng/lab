import { randomUUID } from 'node:crypto'
import { handleChatCompletion } from './chat'
import { safeJsonStringify } from './chat-text'
import { resolveBooleanFeatureToggle } from './feature-flags'

type JsonRecord = Record<string, unknown>

export type DecisionRunState = 'accepted' | 'running' | 'completed' | 'error' | 'timeout'

export type DecisionRunEventType =
  | 'decision.accepted'
  | 'decision.progress'
  | 'decision.context_ready'
  | 'decision.analysis_complete'
  | 'decision.final'
  | 'decision.error'

export type DecisionLlmReviewInput = {
  model?: string
  messages: unknown[]
  temperature?: number
  max_tokens?: number
}

export type DecisionEngineRequest = {
  requestId: string
  symbol: string
  strategyId: string
  trigger: JsonRecord
  portfolio: JsonRecord
  riskPolicy: JsonRecord
  executionContext: JsonRecord
  llmReview: DecisionLlmReviewInput | null
}

export type DecisionRunEvent = {
  sequence: number
  at: string
  type: DecisionRunEventType
  payload: JsonRecord
}

type DecisionRunRecord = {
  runId: string
  requestId: string
  symbol: string
  strategyId: string
  state: DecisionRunState
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  finalPayload: JsonRecord | null
  error: JsonRecord | null
  events: DecisionRunEvent[]
  listeners: Set<(event: DecisionRunEvent) => void>
}

type DecisionRunSubmitResult = {
  run: DecisionRunSnapshot
  idempotent: boolean
}

export type DecisionRunSnapshot = {
  runId: string
  requestId: string
  symbol: string
  strategyId: string
  state: DecisionRunState
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  finalPayload: JsonRecord | null
  error: JsonRecord | null
}

type DecisionExecutorInput = {
  runId: string
  request: DecisionEngineRequest
  signal: AbortSignal
  emitProgress: (message: string, attrs?: JsonRecord) => void
}

type DecisionExecutorResult = {
  decisionIntent: JsonRecord
  llmResponse: {
    content: string
    usage: JsonRecord | null
  } | null
}

type DecisionEngineConfig = {
  runTimeoutMs: number
  heartbeatMs: number
  retentionMs: number
}

const DEFAULT_TORGHUT_DECISION_ENGINE_ENABLED_FLAG_KEY = 'jangar.torghut.decision_engine.enabled'

const globalState = globalThis as typeof globalThis & {
  __torghutDecisionEngine?: {
    config: DecisionEngineConfig
    runsById: Map<string, DecisionRunRecord>
    runsByRequestId: Map<string, string>
    executor: (input: DecisionExecutorInput) => Promise<DecisionExecutorResult>
  }
}

const resolveBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

const loadConfig = (): DecisionEngineConfig => ({
  runTimeoutMs: parsePositiveInt(process.env.JANGAR_TORGHUT_DECISION_RUN_TIMEOUT_MS, 120_000),
  heartbeatMs: parsePositiveInt(process.env.JANGAR_TORGHUT_DECISION_STREAM_HEARTBEAT_MS, 10_000),
  retentionMs: parsePositiveInt(process.env.JANGAR_TORGHUT_DECISION_RUN_RETENTION_MS, 15 * 60 * 1000),
})

const ensureGlobal = () => {
  if (globalState.__torghutDecisionEngine) return globalState.__torghutDecisionEngine
  globalState.__torghutDecisionEngine = {
    config: loadConfig(),
    runsById: new Map(),
    runsByRequestId: new Map(),
    executor: runDefaultDecisionExecutor,
  }
  return globalState.__torghutDecisionEngine
}

const nowIso = () => new Date().toISOString()

const makeSnapshot = (run: DecisionRunRecord): DecisionRunSnapshot => ({
  runId: run.runId,
  requestId: run.requestId,
  symbol: run.symbol,
  strategyId: run.strategyId,
  state: run.state,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
  finalPayload: run.finalPayload,
  error: run.error,
})

const isTerminalState = (state: DecisionRunState) => state === 'completed' || state === 'error' || state === 'timeout'

const pushEvent = (run: DecisionRunRecord, type: DecisionRunEventType, payload: JsonRecord) => {
  const event: DecisionRunEvent = {
    sequence: run.events.length + 1,
    at: nowIso(),
    type,
    payload,
  }
  run.events.push(event)
  run.updatedAt = event.at
  for (const listener of run.listeners) {
    try {
      listener(event)
    } catch {
      // Listener failures should not impact other subscribers.
    }
  }
}

const parseJsonRecord = (value: unknown): JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {}

const coerceString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export const parseDecisionEngineRequest = (
  payload: unknown,
): { ok: true; value: DecisionEngineRequest } | { ok: false; message: string } => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: 'invalid JSON body' }
  }

  const record = payload as JsonRecord
  const requestId = coerceString(record.request_id ?? record.requestId)
  if (!requestId) {
    return { ok: false, message: 'request_id is required' }
  }

  const llmRaw = record.llm_review
  let llmReview: DecisionLlmReviewInput | null = null
  if (typeof llmRaw === 'object' && llmRaw !== null && !Array.isArray(llmRaw)) {
    const llmRecord = llmRaw as JsonRecord
    const messages = Array.isArray(llmRecord.messages) ? llmRecord.messages : null
    if (!messages || messages.length === 0) {
      return { ok: false, message: 'llm_review.messages must be a non-empty array when llm_review is provided' }
    }
    llmReview = {
      model: coerceString(llmRecord.model) ?? undefined,
      messages,
      temperature: parseNumber(llmRecord.temperature) ?? undefined,
      max_tokens: parseNumber(llmRecord.max_tokens) ?? undefined,
    }
  }

  return {
    ok: true,
    value: {
      requestId,
      symbol: coerceString(record.symbol) ?? 'UNKNOWN',
      strategyId: coerceString(record.strategy_id ?? record.strategyId) ?? 'llm-review',
      trigger: parseJsonRecord(record.trigger),
      portfolio: parseJsonRecord(record.portfolio),
      riskPolicy: parseJsonRecord(record.risk_policy ?? record.riskPolicy),
      executionContext: parseJsonRecord(record.execution_context ?? record.executionContext),
      llmReview,
    },
  }
}

const pruneExpiredRuns = () => {
  const state = ensureGlobal()
  const now = Date.now()
  for (const [runId, run] of state.runsById) {
    if (!isTerminalState(run.state) || !run.completedAt) continue
    const ageMs = now - Date.parse(run.completedAt)
    if (Number.isFinite(ageMs) && ageMs > state.config.retentionMs) {
      state.runsById.delete(runId)
      if (state.runsByRequestId.get(run.requestId) === runId) {
        state.runsByRequestId.delete(run.requestId)
      }
    }
  }
}

export const getTorghutDecisionStreamHeartbeatMs = () => ensureGlobal().config.heartbeatMs

export const submitTorghutDecisionRun = (request: DecisionEngineRequest): DecisionRunSubmitResult => {
  const state = ensureGlobal()
  pruneExpiredRuns()

  const existingId = state.runsByRequestId.get(request.requestId)
  if (existingId) {
    const existing = state.runsById.get(existingId)
    if (existing) {
      return { run: makeSnapshot(existing), idempotent: true }
    }
  }

  const createdAt = nowIso()
  const runId = randomUUID()
  const run: DecisionRunRecord = {
    runId,
    requestId: request.requestId,
    symbol: request.symbol,
    strategyId: request.strategyId,
    state: 'accepted',
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    finalPayload: null,
    error: null,
    events: [],
    listeners: new Set(),
  }

  state.runsById.set(runId, run)
  state.runsByRequestId.set(request.requestId, runId)

  pushEvent(run, 'decision.accepted', {
    run_id: runId,
    request_id: run.requestId,
    symbol: run.symbol,
    strategy_id: run.strategyId,
    state: run.state,
    accepted_at: createdAt,
  })

  void executeRun(run, request)

  return { run: makeSnapshot(run), idempotent: false }
}

const executeRun = async (run: DecisionRunRecord, request: DecisionEngineRequest) => {
  const state = ensureGlobal()
  run.state = 'running'
  run.startedAt = nowIso()
  run.updatedAt = run.startedAt

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error('decision run timeout'))
  }, state.config.runTimeoutMs)

  const emitProgress = (message: string, attrs: JsonRecord = {}) => {
    pushEvent(run, 'decision.progress', {
      run_id: run.runId,
      request_id: run.requestId,
      message,
      ...attrs,
    })
  }

  pushEvent(run, 'decision.context_ready', {
    run_id: run.runId,
    request_id: run.requestId,
    symbol: run.symbol,
    strategy_id: run.strategyId,
  })

  try {
    const result = await state.executor({
      runId: run.runId,
      request,
      signal: controller.signal,
      emitProgress,
    })

    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('decision run timeout')
    }

    pushEvent(run, 'decision.analysis_complete', {
      run_id: run.runId,
      request_id: run.requestId,
    })

    run.state = 'completed'
    run.completedAt = nowIso()
    run.updatedAt = run.completedAt
    run.finalPayload = {
      run_id: run.runId,
      request_id: run.requestId,
      decision_intent: result.decisionIntent,
      llm_response: result.llmResponse,
      completed_at: run.completedAt,
    }

    pushEvent(run, 'decision.final', run.finalPayload)
  } catch (error) {
    const timedOut = controller.signal.aborted
    run.state = timedOut ? 'timeout' : 'error'
    run.completedAt = nowIso()
    run.updatedAt = run.completedAt
    const message = error instanceof Error ? error.message : String(error)
    run.error = {
      run_id: run.runId,
      request_id: run.requestId,
      code: timedOut ? 'timeout' : 'run_failed',
      message,
      completed_at: run.completedAt,
    }

    pushEvent(run, 'decision.error', run.error)
  } finally {
    clearTimeout(timeout)
  }
}

export const getTorghutDecisionRun = (runId: string) => {
  const run = ensureGlobal().runsById.get(runId)
  if (!run) return null
  return makeSnapshot(run)
}

export const listTorghutDecisionRunEvents = (runId: string, sinceSequence = 0) => {
  const run = ensureGlobal().runsById.get(runId)
  if (!run) return null
  return run.events.filter((event) => event.sequence > sinceSequence)
}

export const subscribeTorghutDecisionRunEvents = (runId: string, onEvent: (event: DecisionRunEvent) => void) => {
  const run = ensureGlobal().runsById.get(runId)
  if (!run) return null
  run.listeners.add(onEvent)
  return () => run.listeners.delete(onEvent)
}

const shouldAbort = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
  }
}

const parseUsage = (value: unknown): JsonRecord | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const usage = value as JsonRecord
  const out: JsonRecord = {}
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const parsed = parseNumber(usage[key])
    if (parsed !== null) out[key] = Math.trunc(parsed)
  }
  return Object.keys(out).length > 0 ? out : null
}

const parseChatSse = async (response: Response, signal: AbortSignal) => {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const body = await response.text()
    throw new Error(`chat completion stream failed: expected event-stream, got ${contentType} (${body})`)
  }
  if (!response.body) {
    throw new Error('chat completion stream failed: missing body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let usage: JsonRecord | null = null

  try {
    while (true) {
      shouldAbort(signal)
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const lineEnd = buffer.indexOf('\n')
        if (lineEnd < 0) break
        const line = buffer.slice(0, lineEnd).trim()
        buffer = buffer.slice(lineEnd + 1)

        if (!line || !line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          return { content: content.trim(), usage }
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          continue
        }
        const frame = parsed as JsonRecord

        if (frame.error) {
          const errorRecord = parseJsonRecord(frame.error)
          const message = coerceString(errorRecord.message) ?? coerceString(errorRecord.code) ?? 'chat stream error'
          throw new Error(message)
        }

        usage = parseUsage(frame.usage) ?? usage

        const choices = Array.isArray(frame.choices) ? frame.choices : []
        for (const choice of choices) {
          if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) continue
          const choiceRecord = choice as JsonRecord
          const delta = parseJsonRecord(choiceRecord.delta)
          const message = parseJsonRecord(choiceRecord.message)
          const deltaContent = coerceString(delta.content)
          const messageContent = coerceString(message.content)
          if (deltaContent) content += deltaContent
          if (messageContent) content += messageContent
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  throw new Error('chat completion stream ended before [DONE]')
}

const buildDefaultIntent = (request: DecisionEngineRequest, llmContent: string): JsonRecord => ({
  action: 'hold',
  symbol: request.symbol,
  strategy_id: request.strategyId,
  confidence: llmContent.length > 0 ? 0.65 : 0.5,
  qty: '0',
  adapter_hint: 'alpaca',
  rationale: llmContent.length > 0 ? 'llm review completed' : 'no llm review payload supplied',
  risk_flags: llmContent.length > 0 ? [] : ['missing_llm_review'],
})

const runDefaultDecisionExecutor = async (input: DecisionExecutorInput): Promise<DecisionExecutorResult> => {
  input.emitProgress('decision run started', { stage: 'start' })
  shouldAbort(input.signal)

  if (!input.request.llmReview) {
    input.emitProgress('no llm review payload provided', { stage: 'fallback' })
    return {
      decisionIntent: buildDefaultIntent(input.request, ''),
      llmResponse: null,
    }
  }

  input.emitProgress('executing llm review', { stage: 'llm_review' })

  const payload: JsonRecord = {
    model: input.request.llmReview.model ?? 'gpt-5.3-codex',
    messages: input.request.llmReview.messages,
    stream: true,
    stream_options: {
      include_usage: true,
      include_plan: false,
    },
  }
  if (input.request.llmReview.temperature !== undefined) {
    payload.temperature = input.request.llmReview.temperature
  }
  if (input.request.llmReview.max_tokens !== undefined) {
    payload.max_tokens = input.request.llmReview.max_tokens
  }

  const request = new Request('http://localhost/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: safeJsonStringify(payload),
    signal: input.signal,
  })

  const response = await handleChatCompletion(request)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`chat completion failed (${response.status}): ${body}`)
  }

  const parsed = await parseChatSse(response, input.signal)

  input.emitProgress('llm review complete', { stage: 'llm_review_done' })

  return {
    decisionIntent: buildDefaultIntent(input.request, parsed.content),
    llmResponse: {
      content: parsed.content,
      usage: parsed.usage,
    },
  }
}

export const isTorghutDecisionEngineEnabled = () =>
  resolveBooleanFeatureToggle({
    key: DEFAULT_TORGHUT_DECISION_ENGINE_ENABLED_FLAG_KEY,
    keyEnvVar: 'JANGAR_TORGHUT_DECISION_ENGINE_ENABLED_FLAG_KEY',
    fallbackEnvVar: 'JANGAR_TORGHUT_DECISION_ENGINE_ENABLED',
    defaultValue: resolveBoolean(process.env.JANGAR_TORGHUT_DECISION_ENGINE_ENABLED, true),
  })

export const setTorghutDecisionExecutorForTests = (
  executor: (input: DecisionExecutorInput) => Promise<DecisionExecutorResult>,
) => {
  ensureGlobal().executor = executor
}

export const resetTorghutDecisionEngineForTests = () => {
  globalState.__torghutDecisionEngine = {
    config: loadConfig(),
    runsById: new Map(),
    runsByRequestId: new Map(),
    executor: runDefaultDecisionExecutor,
  }
}
