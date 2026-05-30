import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import type {
  AutotraderAppendEventInput,
  AutotraderCreateTradeTicketInput,
  AutotraderEvent,
  AutotraderFill,
  AutotraderFinalizeSessionInput,
  AutotraderGetScorecardInput,
  AutotraderOrder,
  AutotraderPositionSnapshot,
  AutotraderRecordFillInput,
  AutotraderRecordOrderInput,
  AutotraderRecordPositionSnapshotInput,
  AutotraderRecordRiskCheckInput,
  AutotraderRiskCheck,
  AutotraderScorecard,
  AutotraderScorecardObservation,
  AutotraderSession,
  AutotraderSessionDetail,
  AutotraderSetupExample,
  AutotraderStartSessionInput,
  AutotraderStatus,
  AutotraderTradeTicket,
  AutotraderUpsertStatusInput,
} from './autotrader-schema'

export type AutotraderStore = {
  startSession(input: AutotraderStartSessionInput): Promise<AutotraderSession>
  upsertStatus(input: AutotraderUpsertStatusInput): Promise<AutotraderStatus>
  appendEvent(input: AutotraderAppendEventInput): Promise<AutotraderEvent>
  createTradeTicket(input: AutotraderCreateTradeTicketInput): Promise<AutotraderTradeTicket>
  recordRiskCheck(input: AutotraderRecordRiskCheckInput): Promise<AutotraderRiskCheck>
  recordOrder(input: AutotraderRecordOrderInput): Promise<AutotraderOrder>
  recordFill(input: AutotraderRecordFillInput): Promise<AutotraderFill>
  recordPositionSnapshot(input: AutotraderRecordPositionSnapshotInput): Promise<AutotraderPositionSnapshot>
  finalizeSession(input: AutotraderFinalizeSessionInput): Promise<AutotraderSessionDetail>
  getScorecard(input: AutotraderGetScorecardInput): Promise<{
    scorecards: AutotraderScorecard[]
    setupExamples: AutotraderSetupExample[]
  }>
  listSessions(limit: number): Promise<AutotraderSession[]>
  getSessionDetail(sessionId: string): Promise<AutotraderSessionDetail | null>
}

const nowIso = () => new Date().toISOString()

const toIso = (value: Date | string | null | undefined) => {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(value)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return value
}

const observedAtIso = (value: Date | string | null | undefined) => {
  const now = nowIso()
  const observed = toIso(value) ?? now
  const observedMs = Date.parse(observed)
  const nowMs = Date.parse(now)
  if (Number.isFinite(observedMs) && Number.isFinite(nowMs) && observedMs > nowMs + 60_000) return now
  return observed
}

const toPayload = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

const toJson = (value: Record<string, unknown>) => JSON.stringify(value)
const numericOrNull = (value: string | null | undefined) => value ?? null
const normalizedSymbol = (value: string | null | undefined) => value?.trim().toUpperCase() || null
const scorecardSymbol = (value: string | null | undefined) => normalizedSymbol(value) ?? '*'
const brokerReplacesOrderId = (payload: Record<string, unknown>) => {
  const replaces = payload.replaces
  return typeof replaces === 'string' && replaces.trim() ? replaces.trim() : null
}
const numericFromPayload = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const normalized = String(value)
    if (Number.isFinite(Number(normalized))) return normalized
  }
  return null
}

const scorecardKeyFor = (value: {
  symbol?: string | null
  setupType: string
  setupGrade: string
  regime: string
  timeBucket: string
}) =>
  createHash('sha256')
    .update(
      [
        scorecardSymbol(value.symbol),
        value.setupType.trim(),
        value.setupGrade,
        value.regime.trim(),
        value.timeBucket.trim(),
      ]
        .join('|')
        .toLowerCase(),
    )
    .digest('base64url')
    .slice(0, 32)

type FinalizationWarning = {
  type: 'detached_unknown_ticket_id' | 'detached_cross_session_ticket_id'
  ticketId: string
  observationIndex: number
  sessionId: string
  ticketSessionId?: string | null
  symbol?: string | null
  setupType: string
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`
}

const scorecardExampleIdFor = (sessionId: string, observation: AutotraderScorecardObservation) =>
  createHash('sha256')
    .update(
      stableJson({
        sessionId,
        key: scorecardKeyFor(observation),
        ticketId: observation.ticketId ?? null,
        outcome: observation.outcome,
        realizedR: observation.realizedR ?? null,
        notes: observation.notes ?? null,
        mistakeTags: observation.mistakeTags,
        payload: observation.payload,
      }),
    )
    .digest('base64url')
    .slice(0, 40)

const sanitizeScorecardObservations = (
  sessionId: string,
  observations: AutotraderScorecardObservation[],
  ticketSessionById: Map<string, string>,
) => {
  const warnings: FinalizationWarning[] = []
  const sanitized = observations.map((observation, index): AutotraderScorecardObservation => {
    if (!observation.ticketId) return observation
    const ticketSessionId = ticketSessionById.get(observation.ticketId)
    if (ticketSessionId === sessionId) return observation
    const type = ticketSessionId ? 'detached_cross_session_ticket_id' : 'detached_unknown_ticket_id'
    const warning: FinalizationWarning = {
      type,
      ticketId: observation.ticketId,
      observationIndex: index,
      sessionId,
      ticketSessionId: ticketSessionId ?? null,
      symbol: normalizedSymbol(observation.symbol),
      setupType: observation.setupType,
    }
    warnings.push(warning)
    return {
      ...observation,
      ticketId: undefined,
      payload: {
        ...observation.payload,
        detachedTicketId: observation.ticketId,
        finalizationWarning: type,
      },
    }
  })
  return { observations: sanitized, warnings }
}

const summaryWithFinalizationWarnings = (
  summary: Record<string, unknown>,
  warnings: FinalizationWarning[],
): Record<string, unknown> => {
  if (!warnings.length) return summary
  const existing = Array.isArray(summary.finalizationWarnings) ? summary.finalizationWarnings : []
  return { ...summary, finalizationWarnings: [...existing, ...warnings] }
}

const asNumber = (value: string | number | null | undefined) => {
  if (value == null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const averageWithObservation = (currentAverage: string | null, sampleSize: number, next: string | null | undefined) => {
  if (next == null) return currentAverage
  const divisor = sampleSize + 1
  return String((asNumber(currentAverage) * sampleSize + asNumber(next)) / divisor)
}

const confidenceForSampleSize = (sampleSize: number) => String(Number((sampleSize / (sampleSize + 10)).toFixed(4)))

const updateScorecardWithObservation = (
  existing: AutotraderScorecard | null,
  sessionId: string,
  observation: AutotraderScorecardObservation,
): AutotraderScorecard => {
  const key = scorecardKeyFor(observation)
  const sampleSize = (existing?.sampleSize ?? 0) + 1
  const realizedR = observation.realizedR ?? '0'
  const totalRealizedR = asNumber(existing?.totalRealizedR) + asNumber(realizedR)
  const wins = (existing?.wins ?? 0) + (observation.outcome === 'win' ? 1 : 0)
  const losses = (existing?.losses ?? 0) + (observation.outcome === 'loss' ? 1 : 0)
  const scratches = (existing?.scratches ?? 0) + (observation.outcome === 'scratch' ? 1 : 0)
  const rejectedValid = (existing?.rejectedValid ?? 0) + (observation.outcome === 'rejected_valid' ? 1 : 0)
  const rejectedInvalid = (existing?.rejectedInvalid ?? 0) + (observation.outcome === 'rejected_invalid' ? 1 : 0)

  return {
    key,
    symbol: normalizedSymbol(observation.symbol),
    setupType: observation.setupType,
    setupGrade: observation.setupGrade,
    regime: observation.regime,
    timeBucket: observation.timeBucket,
    sampleSize,
    wins,
    losses,
    scratches,
    rejectedValid,
    rejectedInvalid,
    totalRealizedR: String(totalRealizedR),
    avgRealizedR: String(totalRealizedR / sampleSize),
    avgHoldSeconds: averageWithObservation(
      existing?.avgHoldSeconds ?? null,
      existing?.sampleSize ?? 0,
      observation.holdSeconds,
    ),
    avgMfeR: averageWithObservation(existing?.avgMfeR ?? null, existing?.sampleSize ?? 0, observation.mfeR),
    avgMaeR: averageWithObservation(existing?.avgMaeR ?? null, existing?.sampleSize ?? 0, observation.maeR),
    lastOutcome: observation.outcome,
    confidence: confidenceForSampleSize(sampleSize),
    updatedAt: nowIso(),
    lastSessionId: sessionId,
  }
}

const exampleFromObservation = (
  sessionId: string,
  observation: AutotraderScorecardObservation,
): AutotraderSetupExample => ({
  id: scorecardExampleIdFor(sessionId, observation),
  scorecardKey: scorecardKeyFor(observation),
  sessionId,
  ticketId: observation.ticketId ?? null,
  symbol: normalizedSymbol(observation.symbol),
  setupType: observation.setupType,
  setupGrade: observation.setupGrade,
  regime: observation.regime,
  timeBucket: observation.timeBucket,
  outcome: observation.outcome,
  realizedR: observation.realizedR ?? null,
  notes: observation.notes ?? null,
  mistakeTags: observation.mistakeTags,
  payload: observation.payload,
  createdAt: nowIso(),
})

class InMemoryAutotraderStore implements AutotraderStore {
  private sessions = new Map<string, AutotraderSession>()
  private sessionByAgentRunName = new Map<string, string>()
  private statuses = new Map<string, AutotraderStatus>()
  private events = new Map<string, AutotraderEvent>()
  private tickets = new Map<string, AutotraderTradeTicket>()
  private ticketByIdempotency = new Map<string, string>()
  private riskChecks = new Map<string, AutotraderRiskCheck>()
  private riskByIdempotency = new Map<string, string>()
  private orders = new Map<string, AutotraderOrder>()
  private fills = new Map<string, AutotraderFill>()
  private positions = new Map<string, AutotraderPositionSnapshot>()
  private scorecards = new Map<string, AutotraderScorecard>()
  private examples = new Map<string, AutotraderSetupExample>()

  async startSession(input: AutotraderStartSessionInput): Promise<AutotraderSession> {
    const existingId = this.sessionByAgentRunName.get(input.agentRunName)
    const existing = existingId ? this.sessions.get(existingId) : null
    if (existing) return existing

    const session: AutotraderSession = {
      id: randomUUID(),
      agentRunName: input.agentRunName,
      mode: input.mode,
      tradingDate: input.tradingDate,
      accountId: input.accountId ?? null,
      goalEquity: input.goalEquity,
      openingEquity: input.openingEquity ?? null,
      closingEquity: null,
      realizedPnl: null,
      maxDrawdown: null,
      marketOpenAt: input.marketOpenAt,
      marketCloseAt: input.marketCloseAt,
      analysisHead: input.analysisHead ?? null,
      analysisContextHash: input.analysisContextHash ?? null,
      startedAt: nowIso(),
      finalizedAt: null,
      terminalReason: null,
      summary: {},
    }
    this.sessions.set(session.id, session)
    this.sessionByAgentRunName.set(session.agentRunName, session.id)
    return session
  }

  async upsertStatus(input: AutotraderUpsertStatusInput): Promise<AutotraderStatus> {
    this.requireSession(input.sessionId)
    const status: AutotraderStatus = {
      sessionId: input.sessionId,
      cycle: input.cycle,
      phase: input.phase,
      equity: input.equity ?? null,
      buyingPower: input.buyingPower ?? null,
      daytradeBuyingPower: input.daytradeBuyingPower ?? null,
      grossExposure: input.grossExposure ?? null,
      netExposure: input.netExposure ?? null,
      realizedPnl: input.realizedPnl ?? null,
      unrealizedPnl: input.unrealizedPnl ?? null,
      currentAction: input.currentAction,
      blocker: input.blocker ?? null,
      payload: input.payload,
      updatedAt: nowIso(),
    }
    this.statuses.set(input.sessionId, status)
    return status
  }

  async appendEvent(input: AutotraderAppendEventInput): Promise<AutotraderEvent> {
    this.requireSession(input.sessionId)
    const event: AutotraderEvent = {
      sessionId: input.sessionId,
      seq: input.seq,
      occurredAt: toIso(input.occurredAt) ?? nowIso(),
      eventType: input.eventType,
      symbol: normalizedSymbol(input.symbol),
      setupType: input.setupType ?? null,
      setupGrade: input.setupGrade ?? null,
      severity: input.severity,
      payload: input.payload,
    }
    this.events.set(`${input.sessionId}:${input.seq}`, event)
    return event
  }

  async createTradeTicket(input: AutotraderCreateTradeTicketInput): Promise<AutotraderTradeTicket> {
    this.requireSession(input.sessionId)
    const idempotencyKey = `${input.sessionId}:${input.idempotencyKey}`
    const existingId = this.ticketByIdempotency.get(idempotencyKey)
    const existing = existingId ? this.tickets.get(existingId) : null
    const timestamp = nowIso()
    const ticket: AutotraderTradeTicket = {
      id: existing?.id ?? randomUUID(),
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      symbol: normalizedSymbol(input.symbol) ?? input.symbol,
      instrument: input.instrument,
      side: input.side,
      setupType: input.setupType,
      setupGrade: input.setupGrade,
      fatPitch: input.fatPitch,
      regime: input.regime,
      timeBucket: input.timeBucket ?? null,
      thesis: input.thesis,
      entryTrigger: input.entryTrigger,
      invalidation: input.invalidation,
      entryLimitPrice: input.entryLimitPrice ?? null,
      stopPrice: input.stopPrice ?? null,
      targetPrice: input.targetPrice ?? null,
      expectedR: input.expectedR ?? null,
      maxLossAmount: input.maxLossAmount ?? null,
      riskDollars: input.riskDollars ?? null,
      plannedQuantity: input.plannedQuantity ?? null,
      protectionType: input.protectionType,
      brokerOrderPlan: input.brokerOrderPlan,
      status: input.status,
      noTradeReason: input.noTradeReason ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    this.ticketByIdempotency.set(idempotencyKey, ticket.id)
    this.tickets.set(ticket.id, ticket)
    return ticket
  }

  async recordRiskCheck(input: AutotraderRecordRiskCheckInput): Promise<AutotraderRiskCheck> {
    this.requireSession(input.sessionId)
    const key = `${input.sessionId}:${input.idempotencyKey}`
    const existingId = this.riskByIdempotency.get(key)
    const existing = existingId ? this.riskChecks.get(existingId) : null
    const riskCheck: AutotraderRiskCheck = {
      id: existing?.id ?? randomUUID(),
      sessionId: input.sessionId,
      ticketId: input.ticketId ?? null,
      idempotencyKey: input.idempotencyKey,
      checkType: input.checkType,
      passed: input.passed,
      reason: input.reason ?? null,
      payload: input.payload,
      createdAt: existing?.createdAt ?? nowIso(),
    }
    this.riskByIdempotency.set(key, riskCheck.id)
    this.riskChecks.set(riskCheck.id, riskCheck)
    return riskCheck
  }

  async recordOrder(input: AutotraderRecordOrderInput): Promise<AutotraderOrder> {
    this.requireSession(input.sessionId)
    const updatedAt = nowIso()
    const order: AutotraderOrder = {
      sessionId: input.sessionId,
      ticketId: input.ticketId ?? null,
      clientOrderId: input.clientOrderId,
      brokerOrderId: input.brokerOrderId ?? null,
      symbol: normalizedSymbol(input.symbol) ?? input.symbol,
      instrument: input.instrument,
      side: input.side,
      quantity: input.quantity,
      orderType: input.orderType,
      orderClass: input.orderClass ?? null,
      limitPrice: input.limitPrice ?? null,
      stopPrice: input.stopPrice ?? null,
      takeProfitLimitPrice: input.takeProfitLimitPrice ?? null,
      stopLossStopPrice: input.stopLossStopPrice ?? null,
      stopLossLimitPrice: input.stopLossLimitPrice ?? null,
      status: input.status,
      rejectReason: input.rejectReason ?? null,
      brokerPayload: input.brokerPayload,
      updatedAt,
    }
    this.orders.set(order.clientOrderId, order)
    const replaces = brokerReplacesOrderId(input.brokerPayload)
    if (replaces) {
      for (const [clientOrderId, existing] of this.orders) {
        if (existing.sessionId !== order.sessionId) continue
        if (existing.clientOrderId === order.clientOrderId) continue
        if (existing.brokerOrderId !== replaces) continue
        this.orders.set(clientOrderId, {
          ...existing,
          status: 'replaced',
          brokerPayload: {
            ...existing.brokerPayload,
            replacedBy: order.brokerOrderId ?? order.clientOrderId,
            replacementClientOrderId: order.clientOrderId,
            replacementRecordedAt: updatedAt,
          },
          updatedAt,
        })
      }
    }
    return order
  }

  async recordFill(input: AutotraderRecordFillInput): Promise<AutotraderFill> {
    this.requireSession(input.sessionId)
    const fill: AutotraderFill = {
      sessionId: input.sessionId,
      clientOrderId: input.clientOrderId,
      brokerFillId: input.brokerFillId,
      symbol: normalizedSymbol(input.symbol) ?? input.symbol,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      filledAt: toIso(input.filledAt) ?? input.filledAt,
      brokerPayload: input.brokerPayload,
    }
    this.fills.set(fill.brokerFillId, fill)
    return fill
  }

  async recordPositionSnapshot(input: AutotraderRecordPositionSnapshotInput): Promise<AutotraderPositionSnapshot> {
    this.requireSession(input.sessionId)
    const capturedAt = observedAtIso(input.capturedAt)
    const id = `${input.sessionId}:${normalizedSymbol(input.symbol) ?? input.symbol}:${capturedAt}`
    const snapshot: AutotraderPositionSnapshot = {
      id,
      sessionId: input.sessionId,
      symbol: normalizedSymbol(input.symbol) ?? input.symbol,
      quantity: input.quantity,
      marketValue: input.marketValue ?? null,
      averageEntryPrice: input.averageEntryPrice ?? null,
      unrealizedPnl: input.unrealizedPnl ?? null,
      capturedAt,
      brokerPayload: input.brokerPayload,
    }
    this.positions.set(snapshot.id, snapshot)
    return snapshot
  }

  async finalizeSession(input: AutotraderFinalizeSessionInput): Promise<AutotraderSessionDetail> {
    const session = this.requireSession(input.sessionId)
    const ticketSessionById = new Map([...this.tickets.values()].map((ticket) => [ticket.id, ticket.sessionId]))
    const finalization = sanitizeScorecardObservations(input.sessionId, input.scorecardObservations, ticketSessionById)
    const summary = summaryWithFinalizationWarnings(input.summary, finalization.warnings)
    const updatedSession: AutotraderSession = {
      ...session,
      finalizedAt: nowIso(),
      terminalReason: input.terminalReason,
      openingEquity:
        input.openingEquity ??
        numericFromPayload(summary, ['openingEquity', 'opening_equity']) ??
        session.openingEquity,
      closingEquity:
        input.closingEquity ??
        numericFromPayload(summary, ['closingEquity', 'closing_equity', 'accountEquity', 'equity']) ??
        session.closingEquity,
      realizedPnl:
        input.realizedPnl ??
        numericFromPayload(summary, ['realizedPnl', 'realized_pnl', 'realizedPnL']) ??
        session.realizedPnl,
      maxDrawdown:
        input.maxDrawdown ?? numericFromPayload(summary, ['maxDrawdown', 'max_drawdown']) ?? session.maxDrawdown,
      summary,
    }
    this.sessions.set(updatedSession.id, updatedSession)
    for (const observation of finalization.observations) {
      const example = exampleFromObservation(input.sessionId, observation)
      if (this.examples.has(example.id)) continue
      const key = scorecardKeyFor(observation)
      this.scorecards.set(
        key,
        updateScorecardWithObservation(this.scorecards.get(key) ?? null, input.sessionId, observation),
      )
      this.examples.set(example.id, example)
    }
    const detail = await this.getSessionDetail(input.sessionId)
    if (!detail) throw new Error(`Unknown autotrader session: ${input.sessionId}`)
    return detail
  }

  async getScorecard(input: AutotraderGetScorecardInput) {
    const scorecards = [...this.scorecards.values()]
      .filter((scorecard) => (input.symbol ? scorecard.symbol === normalizedSymbol(input.symbol) : true))
      .filter((scorecard) => (input.setupType ? scorecard.setupType === input.setupType : true))
      .filter((scorecard) => (input.setupGrade ? scorecard.setupGrade === input.setupGrade : true))
      .filter((scorecard) => (input.regime ? scorecard.regime === input.regime : true))
      .filter((scorecard) => (input.timeBucket ? scorecard.timeBucket === input.timeBucket : true))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, input.limit)
    const keys = new Set(scorecards.map((scorecard) => scorecard.key))
    const setupExamples = [...this.examples.values()]
      .filter((example) => keys.has(example.scorecardKey))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, input.limit * 3)
    return { scorecards, setupExamples }
  }

  async listSessions(limit: number): Promise<AutotraderSession[]> {
    return [...this.sessions.values()]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, limit)
  }

  async getSessionDetail(sessionId: string): Promise<AutotraderSessionDetail | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const sessionTickets = [...this.tickets.values()].filter((ticket) => ticket.sessionId === sessionId)
    const sessionExamples = [...this.examples.values()].filter((example) => example.sessionId === sessionId)
    const sessionScorecardKeys = new Set([
      ...sessionExamples.map((example) => example.scorecardKey),
      ...sessionTickets.map((ticket) =>
        scorecardKeyFor({
          symbol: ticket.symbol,
          setupType: ticket.setupType,
          setupGrade: ticket.setupGrade,
          regime: ticket.regime,
          timeBucket: ticket.timeBucket ?? 'unknown',
        }),
      ),
    ])
    return {
      session,
      status: this.statuses.get(sessionId) ?? null,
      events: [...this.events.values()]
        .filter((event) => event.sessionId === sessionId)
        .sort((left, right) => left.seq - right.seq),
      tradeTickets: sessionTickets,
      riskChecks: [...this.riskChecks.values()].filter((riskCheck) => riskCheck.sessionId === sessionId),
      orders: [...this.orders.values()].filter((order) => order.sessionId === sessionId),
      fills: [...this.fills.values()].filter((fill) => fill.sessionId === sessionId),
      positionSnapshots: [...this.positions.values()]
        .filter((snapshot) => snapshot.sessionId === sessionId)
        .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt)),
      scorecards: [...this.scorecards.values()].filter((scorecard) => sessionScorecardKeys.has(scorecard.key)),
      setupExamples: sessionExamples,
    }
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown autotrader session: ${sessionId}`)
    return session
  }
}

type SessionRow = {
  id: string
  agent_run_name: string
  mode: AutotraderSession['mode']
  trading_date: string
  account_id: string | null
  goal_equity: string
  opening_equity: string | null
  closing_equity: string | null
  realized_pnl: string | null
  max_drawdown: string | null
  market_open_at: Date | string
  market_close_at: Date | string
  analysis_head: string | null
  analysis_context_hash: string | null
  started_at: Date | string
  finalized_at: Date | string | null
  terminal_reason: string | null
  summary: unknown
}

type StatusRow = {
  session_id: string
  cycle: number
  phase: AutotraderStatus['phase']
  equity: string | null
  buying_power: string | null
  daytrade_buying_power: string | null
  gross_exposure: string | null
  net_exposure: string | null
  realized_pnl: string | null
  unrealized_pnl: string | null
  current_action: string
  blocker: string | null
  payload: unknown
  updated_at: Date | string
}

type EventRow = {
  session_id: string
  seq: number
  occurred_at: Date | string
  event_type: string
  symbol: string | null
  setup_type: string | null
  setup_grade: AutotraderEvent['setupGrade']
  severity: AutotraderEvent['severity']
  payload: unknown
}

type TicketRow = {
  id: string
  session_id: string
  idempotency_key: string
  symbol: string
  instrument: AutotraderTradeTicket['instrument']
  side: AutotraderTradeTicket['side']
  setup_type: string
  setup_grade: AutotraderTradeTicket['setupGrade']
  fat_pitch: boolean
  regime: string
  time_bucket: string | null
  thesis: string
  entry_trigger: string
  invalidation: string
  entry_limit_price: string | null
  stop_price: string | null
  target_price: string | null
  expected_r: string | null
  max_loss_amount: string | null
  risk_dollars: string | null
  planned_quantity: string | null
  protection_type: string
  broker_order_plan: unknown
  status: AutotraderTradeTicket['status']
  no_trade_reason: string | null
  created_at: Date | string
  updated_at: Date | string
}

type RiskCheckRow = {
  id: string
  session_id: string
  ticket_id: string | null
  idempotency_key: string
  check_type: string
  passed: boolean
  reason: string | null
  payload: unknown
  created_at: Date | string
}

type OrderRow = {
  session_id: string
  ticket_id: string | null
  client_order_id: string
  broker_order_id: string | null
  symbol: string
  instrument: AutotraderOrder['instrument']
  side: AutotraderOrder['side']
  quantity: string
  order_type: string
  order_class: string | null
  limit_price: string | null
  stop_price: string | null
  take_profit_limit_price: string | null
  stop_loss_stop_price: string | null
  stop_loss_limit_price: string | null
  status: AutotraderOrder['status']
  reject_reason: string | null
  broker_payload: unknown
  updated_at: Date | string
}

type FillRow = {
  session_id: string
  client_order_id: string
  broker_fill_id: string
  symbol: string
  side: AutotraderFill['side']
  quantity: string
  price: string
  filled_at: Date | string
  broker_payload: unknown
}

type PositionSnapshotRow = {
  id: string
  session_id: string
  symbol: string
  quantity: string
  market_value: string | null
  average_entry_price: string | null
  unrealized_pnl: string | null
  captured_at: Date | string
  broker_payload: unknown
}

type ScorecardRow = {
  key: string
  symbol: string | null
  setup_type: string
  setup_grade: AutotraderScorecard['setupGrade']
  regime: string
  time_bucket: string
  sample_size: number
  wins: number
  losses: number
  scratches: number
  rejected_valid: number
  rejected_invalid: number
  total_realized_r: string
  avg_realized_r: string
  avg_hold_seconds: string | null
  avg_mfe_r: string | null
  avg_mae_r: string | null
  last_outcome: AutotraderScorecard['lastOutcome']
  confidence: string
  updated_at: Date | string
  last_session_id: string | null
}

type SetupExampleRow = {
  id: string
  scorecard_key: string
  session_id: string
  ticket_id: string | null
  symbol: string | null
  setup_type: string
  setup_grade: AutotraderSetupExample['setupGrade']
  regime: string
  time_bucket: string
  outcome: AutotraderSetupExample['outcome']
  realized_r: string | null
  notes: string | null
  mistake_tags: unknown
  payload: unknown
  created_at: Date | string
}

const mapSession = (row: SessionRow): AutotraderSession => ({
  id: row.id,
  agentRunName: row.agent_run_name,
  mode: row.mode,
  tradingDate: row.trading_date,
  accountId: row.account_id,
  goalEquity: String(row.goal_equity),
  openingEquity: row.opening_equity == null ? null : String(row.opening_equity),
  closingEquity: row.closing_equity == null ? null : String(row.closing_equity),
  realizedPnl: row.realized_pnl == null ? null : String(row.realized_pnl),
  maxDrawdown: row.max_drawdown == null ? null : String(row.max_drawdown),
  marketOpenAt: toIso(row.market_open_at) ?? String(row.market_open_at),
  marketCloseAt: toIso(row.market_close_at) ?? String(row.market_close_at),
  analysisHead: row.analysis_head,
  analysisContextHash: row.analysis_context_hash,
  startedAt: toIso(row.started_at) ?? nowIso(),
  finalizedAt: toIso(row.finalized_at),
  terminalReason: row.terminal_reason,
  summary: toPayload(row.summary),
})

const mapStatus = (row: StatusRow): AutotraderStatus => ({
  sessionId: row.session_id,
  cycle: Number(row.cycle),
  phase: row.phase,
  equity: row.equity == null ? null : String(row.equity),
  buyingPower: row.buying_power == null ? null : String(row.buying_power),
  daytradeBuyingPower: row.daytrade_buying_power == null ? null : String(row.daytrade_buying_power),
  grossExposure: row.gross_exposure == null ? null : String(row.gross_exposure),
  netExposure: row.net_exposure == null ? null : String(row.net_exposure),
  realizedPnl: row.realized_pnl == null ? null : String(row.realized_pnl),
  unrealizedPnl: row.unrealized_pnl == null ? null : String(row.unrealized_pnl),
  currentAction: row.current_action,
  blocker: row.blocker,
  payload: toPayload(row.payload),
  updatedAt: toIso(row.updated_at) ?? nowIso(),
})

const mapEvent = (row: EventRow): AutotraderEvent => ({
  sessionId: row.session_id,
  seq: Number(row.seq),
  occurredAt: toIso(row.occurred_at) ?? nowIso(),
  eventType: row.event_type,
  symbol: row.symbol,
  setupType: row.setup_type,
  setupGrade: row.setup_grade,
  severity: row.severity,
  payload: toPayload(row.payload),
})

const mapTicket = (row: TicketRow): AutotraderTradeTicket => ({
  id: row.id,
  sessionId: row.session_id,
  idempotencyKey: row.idempotency_key,
  symbol: row.symbol,
  instrument: row.instrument,
  side: row.side,
  setupType: row.setup_type,
  setupGrade: row.setup_grade,
  fatPitch: row.fat_pitch,
  regime: row.regime,
  timeBucket: row.time_bucket,
  thesis: row.thesis,
  entryTrigger: row.entry_trigger,
  invalidation: row.invalidation,
  entryLimitPrice: row.entry_limit_price == null ? null : String(row.entry_limit_price),
  stopPrice: row.stop_price == null ? null : String(row.stop_price),
  targetPrice: row.target_price == null ? null : String(row.target_price),
  expectedR: row.expected_r == null ? null : String(row.expected_r),
  maxLossAmount: row.max_loss_amount == null ? null : String(row.max_loss_amount),
  riskDollars: row.risk_dollars == null ? null : String(row.risk_dollars),
  plannedQuantity: row.planned_quantity == null ? null : String(row.planned_quantity),
  protectionType: row.protection_type,
  brokerOrderPlan: toPayload(row.broker_order_plan),
  status: row.status,
  noTradeReason: row.no_trade_reason,
  createdAt: toIso(row.created_at) ?? nowIso(),
  updatedAt: toIso(row.updated_at) ?? nowIso(),
})

const mapRiskCheck = (row: RiskCheckRow): AutotraderRiskCheck => ({
  id: row.id,
  sessionId: row.session_id,
  ticketId: row.ticket_id,
  idempotencyKey: row.idempotency_key,
  checkType: row.check_type,
  passed: row.passed,
  reason: row.reason,
  payload: toPayload(row.payload),
  createdAt: toIso(row.created_at) ?? nowIso(),
})

const mapOrder = (row: OrderRow): AutotraderOrder => ({
  sessionId: row.session_id,
  ticketId: row.ticket_id,
  clientOrderId: row.client_order_id,
  brokerOrderId: row.broker_order_id,
  symbol: row.symbol,
  instrument: row.instrument,
  side: row.side,
  quantity: String(row.quantity),
  orderType: row.order_type,
  orderClass: row.order_class,
  limitPrice: row.limit_price == null ? null : String(row.limit_price),
  stopPrice: row.stop_price == null ? null : String(row.stop_price),
  takeProfitLimitPrice: row.take_profit_limit_price == null ? null : String(row.take_profit_limit_price),
  stopLossStopPrice: row.stop_loss_stop_price == null ? null : String(row.stop_loss_stop_price),
  stopLossLimitPrice: row.stop_loss_limit_price == null ? null : String(row.stop_loss_limit_price),
  status: row.status,
  rejectReason: row.reject_reason,
  brokerPayload: toPayload(row.broker_payload),
  updatedAt: toIso(row.updated_at) ?? nowIso(),
})

const mapFill = (row: FillRow): AutotraderFill => ({
  sessionId: row.session_id,
  clientOrderId: row.client_order_id,
  brokerFillId: row.broker_fill_id,
  symbol: row.symbol,
  side: row.side,
  quantity: String(row.quantity),
  price: String(row.price),
  filledAt: toIso(row.filled_at) ?? nowIso(),
  brokerPayload: toPayload(row.broker_payload),
})

const mapPositionSnapshot = (row: PositionSnapshotRow): AutotraderPositionSnapshot => ({
  id: row.id,
  sessionId: row.session_id,
  symbol: row.symbol,
  quantity: String(row.quantity),
  marketValue: row.market_value == null ? null : String(row.market_value),
  averageEntryPrice: row.average_entry_price == null ? null : String(row.average_entry_price),
  unrealizedPnl: row.unrealized_pnl == null ? null : String(row.unrealized_pnl),
  capturedAt: toIso(row.captured_at) ?? nowIso(),
  brokerPayload: toPayload(row.broker_payload),
})

const mapScorecard = (row: ScorecardRow): AutotraderScorecard => ({
  key: row.key,
  symbol: row.symbol,
  setupType: row.setup_type,
  setupGrade: row.setup_grade,
  regime: row.regime,
  timeBucket: row.time_bucket,
  sampleSize: Number(row.sample_size),
  wins: Number(row.wins),
  losses: Number(row.losses),
  scratches: Number(row.scratches),
  rejectedValid: Number(row.rejected_valid),
  rejectedInvalid: Number(row.rejected_invalid),
  totalRealizedR: String(row.total_realized_r),
  avgRealizedR: String(row.avg_realized_r),
  avgHoldSeconds: row.avg_hold_seconds == null ? null : String(row.avg_hold_seconds),
  avgMfeR: row.avg_mfe_r == null ? null : String(row.avg_mfe_r),
  avgMaeR: row.avg_mae_r == null ? null : String(row.avg_mae_r),
  lastOutcome: row.last_outcome,
  confidence: String(row.confidence),
  updatedAt: toIso(row.updated_at) ?? nowIso(),
  lastSessionId: row.last_session_id,
})

const mapSetupExample = (row: SetupExampleRow): AutotraderSetupExample => ({
  id: row.id,
  scorecardKey: row.scorecard_key,
  sessionId: row.session_id,
  ticketId: row.ticket_id,
  symbol: row.symbol,
  setupType: row.setup_type,
  setupGrade: row.setup_grade,
  regime: row.regime,
  timeBucket: row.time_bucket,
  outcome: row.outcome,
  realizedR: row.realized_r == null ? null : String(row.realized_r),
  notes: row.notes,
  mistakeTags: Array.isArray(row.mistake_tags) ? row.mistake_tags.map(String) : [],
  payload: toPayload(row.payload),
  createdAt: toIso(row.created_at) ?? nowIso(),
})

class PostgresAutotraderStore implements AutotraderStore {
  private readonly pool: Pool
  private schemaPromise: Promise<void> | null = null

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 })
  }

  async startSession(input: AutotraderStartSessionInput): Promise<AutotraderSession> {
    await this.ensureSchema()
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO autotrader.sessions (
        id, agent_run_name, mode, trading_date, account_id, goal_equity, market_open_at, market_close_at,
        analysis_head, analysis_context_hash, opening_equity
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11)
      ON CONFLICT (agent_run_name) DO UPDATE SET
        mode = EXCLUDED.mode,
        account_id = COALESCE(EXCLUDED.account_id, autotrader.sessions.account_id),
        goal_equity = EXCLUDED.goal_equity,
        opening_equity = COALESCE(EXCLUDED.opening_equity, autotrader.sessions.opening_equity),
        market_open_at = EXCLUDED.market_open_at,
        market_close_at = EXCLUDED.market_close_at,
        analysis_head = COALESCE(EXCLUDED.analysis_head, autotrader.sessions.analysis_head),
        analysis_context_hash = COALESCE(EXCLUDED.analysis_context_hash, autotrader.sessions.analysis_context_hash)
      RETURNING *`,
      [
        randomUUID(),
        input.agentRunName,
        input.mode,
        input.tradingDate,
        input.accountId ?? null,
        input.goalEquity,
        input.marketOpenAt,
        input.marketCloseAt,
        input.analysisHead ?? null,
        input.analysisContextHash ?? null,
        numericOrNull(input.openingEquity),
      ],
    )
    return mapSession(result.rows[0])
  }

  async upsertStatus(input: AutotraderUpsertStatusInput): Promise<AutotraderStatus> {
    await this.ensureSchema()
    const result = await this.pool.query<StatusRow>(
      `INSERT INTO autotrader.status (
        session_id, cycle, phase, equity, buying_power, daytrade_buying_power, gross_exposure, net_exposure,
        realized_pnl, unrealized_pnl, current_action, blocker, payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      ON CONFLICT (session_id) DO UPDATE SET
        cycle = EXCLUDED.cycle,
        phase = EXCLUDED.phase,
        equity = EXCLUDED.equity,
        buying_power = EXCLUDED.buying_power,
        daytrade_buying_power = EXCLUDED.daytrade_buying_power,
        gross_exposure = EXCLUDED.gross_exposure,
        net_exposure = EXCLUDED.net_exposure,
        realized_pnl = EXCLUDED.realized_pnl,
        unrealized_pnl = EXCLUDED.unrealized_pnl,
        current_action = EXCLUDED.current_action,
        blocker = EXCLUDED.blocker,
        payload = EXCLUDED.payload,
        updated_at = now()
      RETURNING *`,
      [
        input.sessionId,
        input.cycle,
        input.phase,
        numericOrNull(input.equity),
        numericOrNull(input.buyingPower),
        numericOrNull(input.daytradeBuyingPower),
        numericOrNull(input.grossExposure),
        numericOrNull(input.netExposure),
        numericOrNull(input.realizedPnl),
        numericOrNull(input.unrealizedPnl),
        input.currentAction,
        input.blocker ?? null,
        toJson(input.payload),
      ],
    )
    return mapStatus(result.rows[0])
  }

  async appendEvent(input: AutotraderAppendEventInput): Promise<AutotraderEvent> {
    await this.ensureSchema()
    const result = await this.pool.query<EventRow>(
      `INSERT INTO autotrader.events (
        session_id, seq, occurred_at, event_type, symbol, setup_type, setup_grade, severity, payload
      )
      VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (session_id, seq) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        event_type = EXCLUDED.event_type,
        symbol = EXCLUDED.symbol,
        setup_type = EXCLUDED.setup_type,
        setup_grade = EXCLUDED.setup_grade,
        severity = EXCLUDED.severity,
        payload = EXCLUDED.payload
      RETURNING *`,
      [
        input.sessionId,
        input.seq,
        input.occurredAt ?? null,
        input.eventType,
        normalizedSymbol(input.symbol),
        input.setupType ?? null,
        input.setupGrade ?? null,
        input.severity,
        toJson(input.payload),
      ],
    )
    return mapEvent(result.rows[0])
  }

  async createTradeTicket(input: AutotraderCreateTradeTicketInput): Promise<AutotraderTradeTicket> {
    await this.ensureSchema()
    const result = await this.pool.query<TicketRow>(
      `INSERT INTO autotrader.trade_tickets (
        id, session_id, idempotency_key, symbol, instrument, side, setup_type, setup_grade, fat_pitch, regime,
        time_bucket, thesis, entry_trigger, invalidation, entry_limit_price, stop_price, target_price, expected_r,
        max_loss_amount, risk_dollars, planned_quantity, protection_type, broker_order_plan, status, no_trade_reason
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23::jsonb, $24, $25
      )
      ON CONFLICT (session_id, idempotency_key) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        instrument = EXCLUDED.instrument,
        side = EXCLUDED.side,
        setup_type = EXCLUDED.setup_type,
        setup_grade = EXCLUDED.setup_grade,
        fat_pitch = EXCLUDED.fat_pitch,
        regime = EXCLUDED.regime,
        time_bucket = EXCLUDED.time_bucket,
        thesis = EXCLUDED.thesis,
        entry_trigger = EXCLUDED.entry_trigger,
        invalidation = EXCLUDED.invalidation,
        entry_limit_price = EXCLUDED.entry_limit_price,
        stop_price = EXCLUDED.stop_price,
        target_price = EXCLUDED.target_price,
        expected_r = EXCLUDED.expected_r,
        max_loss_amount = EXCLUDED.max_loss_amount,
        risk_dollars = EXCLUDED.risk_dollars,
        planned_quantity = EXCLUDED.planned_quantity,
        protection_type = EXCLUDED.protection_type,
        broker_order_plan = EXCLUDED.broker_order_plan,
        status = EXCLUDED.status,
        no_trade_reason = EXCLUDED.no_trade_reason,
        updated_at = now()
      RETURNING *`,
      [
        randomUUID(),
        input.sessionId,
        input.idempotencyKey,
        normalizedSymbol(input.symbol) ?? input.symbol,
        input.instrument,
        input.side,
        input.setupType,
        input.setupGrade,
        input.fatPitch,
        input.regime,
        input.timeBucket ?? null,
        input.thesis,
        input.entryTrigger,
        input.invalidation,
        numericOrNull(input.entryLimitPrice),
        numericOrNull(input.stopPrice),
        numericOrNull(input.targetPrice),
        numericOrNull(input.expectedR),
        numericOrNull(input.maxLossAmount),
        numericOrNull(input.riskDollars),
        numericOrNull(input.plannedQuantity),
        input.protectionType,
        toJson(input.brokerOrderPlan),
        input.status,
        input.noTradeReason ?? null,
      ],
    )
    return mapTicket(result.rows[0])
  }

  async recordRiskCheck(input: AutotraderRecordRiskCheckInput): Promise<AutotraderRiskCheck> {
    await this.ensureSchema()
    const result = await this.pool.query<RiskCheckRow>(
      `INSERT INTO autotrader.risk_checks (
        id, session_id, ticket_id, idempotency_key, check_type, passed, reason, payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (session_id, idempotency_key) DO UPDATE SET
        ticket_id = EXCLUDED.ticket_id,
        check_type = EXCLUDED.check_type,
        passed = EXCLUDED.passed,
        reason = EXCLUDED.reason,
        payload = EXCLUDED.payload
      RETURNING *`,
      [
        randomUUID(),
        input.sessionId,
        input.ticketId ?? null,
        input.idempotencyKey,
        input.checkType,
        input.passed,
        input.reason ?? null,
        toJson(input.payload),
      ],
    )
    return mapRiskCheck(result.rows[0])
  }

  async recordOrder(input: AutotraderRecordOrderInput): Promise<AutotraderOrder> {
    await this.ensureSchema()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<OrderRow>(
        `INSERT INTO autotrader.orders (
          session_id, ticket_id, client_order_id, broker_order_id, symbol, instrument, side, quantity, order_type,
          order_class, limit_price, stop_price, take_profit_limit_price, stop_loss_stop_price, stop_loss_limit_price,
          status, reject_reason, broker_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
        ON CONFLICT (client_order_id) DO UPDATE SET
          session_id = EXCLUDED.session_id,
          ticket_id = EXCLUDED.ticket_id,
          broker_order_id = COALESCE(EXCLUDED.broker_order_id, autotrader.orders.broker_order_id),
          symbol = EXCLUDED.symbol,
          instrument = EXCLUDED.instrument,
          side = EXCLUDED.side,
          quantity = EXCLUDED.quantity,
          order_type = EXCLUDED.order_type,
          order_class = EXCLUDED.order_class,
          limit_price = EXCLUDED.limit_price,
          stop_price = EXCLUDED.stop_price,
          take_profit_limit_price = EXCLUDED.take_profit_limit_price,
          stop_loss_stop_price = EXCLUDED.stop_loss_stop_price,
          stop_loss_limit_price = EXCLUDED.stop_loss_limit_price,
          status = EXCLUDED.status,
          reject_reason = EXCLUDED.reject_reason,
          broker_payload = EXCLUDED.broker_payload,
          updated_at = now()
        RETURNING *`,
        [
          input.sessionId,
          input.ticketId ?? null,
          input.clientOrderId,
          input.brokerOrderId ?? null,
          normalizedSymbol(input.symbol) ?? input.symbol,
          input.instrument,
          input.side,
          input.quantity,
          input.orderType,
          input.orderClass ?? null,
          numericOrNull(input.limitPrice),
          numericOrNull(input.stopPrice),
          numericOrNull(input.takeProfitLimitPrice),
          numericOrNull(input.stopLossStopPrice),
          numericOrNull(input.stopLossLimitPrice),
          input.status,
          input.rejectReason ?? null,
          toJson(input.brokerPayload),
        ],
      )
      const order = mapOrder(result.rows[0])
      const replaces = brokerReplacesOrderId(input.brokerPayload)
      if (replaces) {
        await client.query(
          `UPDATE autotrader.orders
           SET status = 'replaced',
               broker_payload = broker_payload || jsonb_build_object(
                 'replacedBy', $3::text,
                 'replacementClientOrderId', $4::text,
                 'replacementRecordedAt', now()::text
               ),
               updated_at = now()
           WHERE session_id = $1
             AND broker_order_id = $2
             AND client_order_id <> $4
             AND status <> 'replaced'`,
          [input.sessionId, replaces, input.brokerOrderId ?? input.clientOrderId, input.clientOrderId],
        )
      }
      await client.query('COMMIT')
      return order
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async recordFill(input: AutotraderRecordFillInput): Promise<AutotraderFill> {
    await this.ensureSchema()
    const result = await this.pool.query<FillRow>(
      `INSERT INTO autotrader.fills (
        session_id, client_order_id, broker_fill_id, symbol, side, quantity, price, filled_at, broker_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)
      ON CONFLICT (broker_fill_id) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        client_order_id = EXCLUDED.client_order_id,
        symbol = EXCLUDED.symbol,
        side = EXCLUDED.side,
        quantity = EXCLUDED.quantity,
        price = EXCLUDED.price,
        filled_at = EXCLUDED.filled_at,
        broker_payload = EXCLUDED.broker_payload
      RETURNING *`,
      [
        input.sessionId,
        input.clientOrderId,
        input.brokerFillId,
        normalizedSymbol(input.symbol) ?? input.symbol,
        input.side,
        input.quantity,
        input.price,
        input.filledAt,
        toJson(input.brokerPayload),
      ],
    )
    return mapFill(result.rows[0])
  }

  async recordPositionSnapshot(input: AutotraderRecordPositionSnapshotInput): Promise<AutotraderPositionSnapshot> {
    await this.ensureSchema()
    const capturedAt = observedAtIso(input.capturedAt)
    const result = await this.pool.query<PositionSnapshotRow>(
      `INSERT INTO autotrader.position_snapshots (
        id, session_id, symbol, quantity, market_value, average_entry_price, unrealized_pnl, captured_at, broker_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)
      ON CONFLICT (session_id, symbol, captured_at) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        market_value = EXCLUDED.market_value,
        average_entry_price = EXCLUDED.average_entry_price,
        unrealized_pnl = EXCLUDED.unrealized_pnl,
        broker_payload = EXCLUDED.broker_payload
      RETURNING *`,
      [
        randomUUID(),
        input.sessionId,
        normalizedSymbol(input.symbol) ?? input.symbol,
        input.quantity,
        numericOrNull(input.marketValue),
        numericOrNull(input.averageEntryPrice),
        numericOrNull(input.unrealizedPnl),
        capturedAt,
        toJson(input.brokerPayload),
      ],
    )
    return mapPositionSnapshot(result.rows[0])
  }

  async finalizeSession(input: AutotraderFinalizeSessionInput): Promise<AutotraderSessionDetail> {
    await this.ensureSchema()
    const client = await this.pool.connect()
    const openingEquity =
      input.openingEquity ?? numericFromPayload(input.summary, ['openingEquity', 'opening_equity']) ?? null
    const closingEquity =
      input.closingEquity ??
      numericFromPayload(input.summary, ['closingEquity', 'closing_equity', 'accountEquity', 'equity'])
    const realizedPnl =
      input.realizedPnl ?? numericFromPayload(input.summary, ['realizedPnl', 'realized_pnl', 'realizedPnL'])
    const maxDrawdown = input.maxDrawdown ?? numericFromPayload(input.summary, ['maxDrawdown', 'max_drawdown'])
    try {
      await client.query('BEGIN')
      const ticketSessionById = await this.ticketSessionLookup(client, input.scorecardObservations)
      const finalization = sanitizeScorecardObservations(
        input.sessionId,
        input.scorecardObservations,
        ticketSessionById,
      )
      const summary = summaryWithFinalizationWarnings(input.summary, finalization.warnings)
      await client.query(
        `UPDATE autotrader.sessions
         SET finalized_at = now(),
             terminal_reason = $2,
             summary = $3::jsonb,
             opening_equity = COALESCE($4, opening_equity),
             closing_equity = COALESCE($5, closing_equity),
             realized_pnl = COALESCE($6, realized_pnl),
             max_drawdown = COALESCE($7, max_drawdown)
         WHERE id = $1`,
        [
          input.sessionId,
          input.terminalReason,
          toJson(summary),
          numericOrNull(openingEquity),
          numericOrNull(closingEquity),
          numericOrNull(realizedPnl),
          numericOrNull(maxDrawdown),
        ],
      )
      for (const observation of finalization.observations) {
        await this.recordScorecardObservation(client, input.sessionId, observation)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const detail = await this.getSessionDetail(input.sessionId)
    if (!detail) throw new Error(`Unknown autotrader session: ${input.sessionId}`)
    return detail
  }

  private async ticketSessionLookup(
    client: PoolClient,
    observations: AutotraderScorecardObservation[],
  ): Promise<Map<string, string>> {
    const ticketIds = [
      ...new Set(
        observations
          .map((observation) => observation.ticketId)
          .filter((ticketId): ticketId is string => Boolean(ticketId)),
      ),
    ]
    if (!ticketIds.length) return new Map()
    const result = await client.query<{ id: string; session_id: string }>(
      `SELECT id, session_id FROM autotrader.trade_tickets WHERE id = ANY($1::text[])`,
      [ticketIds],
    )
    return new Map(result.rows.map((row) => [row.id, row.session_id]))
  }

  async getScorecard(input: AutotraderGetScorecardInput) {
    await this.ensureSchema()
    const where: string[] = []
    const values: unknown[] = []
    if (input.symbol) {
      values.push(normalizedSymbol(input.symbol))
      where.push(`symbol = $${values.length}`)
    }
    if (input.setupType) {
      values.push(input.setupType)
      where.push(`setup_type = $${values.length}`)
    }
    if (input.setupGrade) {
      values.push(input.setupGrade)
      where.push(`setup_grade = $${values.length}`)
    }
    if (input.regime) {
      values.push(input.regime)
      where.push(`regime = $${values.length}`)
    }
    if (input.timeBucket) {
      values.push(input.timeBucket)
      where.push(`time_bucket = $${values.length}`)
    }
    values.push(input.limit)
    const scorecards = (
      await this.pool.query<ScorecardRow>(
        `SELECT * FROM autotrader.scorecards
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY updated_at DESC
         LIMIT $${values.length}`,
        values,
      )
    ).rows.map(mapScorecard)
    const keys = scorecards.map((scorecard) => scorecard.key)
    if (!keys.length) return { scorecards, setupExamples: [] }
    const setupExamples = (
      await this.pool.query<SetupExampleRow>(
        `SELECT * FROM autotrader.setup_examples
         WHERE scorecard_key = ANY($1)
         ORDER BY created_at DESC
         LIMIT $2`,
        [keys, input.limit * 3],
      )
    ).rows.map(mapSetupExample)
    return { scorecards, setupExamples }
  }

  async listSessions(limit: number): Promise<AutotraderSession[]> {
    await this.ensureSchema()
    const result = await this.pool.query<SessionRow>(
      `SELECT * FROM autotrader.sessions ORDER BY started_at DESC LIMIT $1`,
      [limit],
    )
    return result.rows.map(mapSession)
  }

  async getSessionDetail(sessionId: string): Promise<AutotraderSessionDetail | null> {
    await this.ensureSchema()
    const sessionResult = await this.pool.query<SessionRow>(`SELECT * FROM autotrader.sessions WHERE id = $1`, [
      sessionId,
    ])
    const session = sessionResult.rows[0] ? mapSession(sessionResult.rows[0]) : null
    if (!session) return null
    const [
      statusResult,
      eventResult,
      ticketResult,
      riskResult,
      orderResult,
      fillResult,
      positionResult,
      scorecardResult,
      exampleResult,
    ] = await Promise.all([
      this.pool.query<StatusRow>(`SELECT * FROM autotrader.status WHERE session_id = $1`, [sessionId]),
      this.pool.query<EventRow>(`SELECT * FROM autotrader.events WHERE session_id = $1 ORDER BY seq ASC`, [sessionId]),
      this.pool.query<TicketRow>(
        `SELECT * FROM autotrader.trade_tickets WHERE session_id = $1 ORDER BY created_at ASC`,
        [sessionId],
      ),
      this.pool.query<RiskCheckRow>(
        `SELECT * FROM autotrader.risk_checks WHERE session_id = $1 ORDER BY created_at ASC`,
        [sessionId],
      ),
      this.pool.query<OrderRow>(`SELECT * FROM autotrader.orders WHERE session_id = $1 ORDER BY updated_at ASC`, [
        sessionId,
      ]),
      this.pool.query<FillRow>(`SELECT * FROM autotrader.fills WHERE session_id = $1 ORDER BY filled_at ASC`, [
        sessionId,
      ]),
      this.pool.query<PositionSnapshotRow>(
        `SELECT * FROM autotrader.position_snapshots WHERE session_id = $1 ORDER BY captured_at DESC`,
        [sessionId],
      ),
      this.pool.query<ScorecardRow>(
        `SELECT DISTINCT s.*
         FROM autotrader.scorecards s
         JOIN autotrader.setup_examples e ON e.scorecard_key = s.key
         WHERE e.session_id = $1
         ORDER BY s.updated_at DESC`,
        [sessionId],
      ),
      this.pool.query<SetupExampleRow>(
        `SELECT * FROM autotrader.setup_examples WHERE session_id = $1 ORDER BY created_at DESC`,
        [sessionId],
      ),
    ])
    return {
      session,
      status: statusResult.rows[0] ? mapStatus(statusResult.rows[0]) : null,
      events: eventResult.rows.map(mapEvent),
      tradeTickets: ticketResult.rows.map(mapTicket),
      riskChecks: riskResult.rows.map(mapRiskCheck),
      orders: orderResult.rows.map(mapOrder),
      fills: fillResult.rows.map(mapFill),
      positionSnapshots: positionResult.rows.map(mapPositionSnapshot),
      scorecards: scorecardResult.rows.map(mapScorecard),
      setupExamples: exampleResult.rows.map(mapSetupExample),
    }
  }

  private async recordScorecardObservation(
    client: PoolClient,
    sessionId: string,
    observation: AutotraderScorecardObservation,
  ) {
    const key = scorecardKeyFor(observation)
    const example = exampleFromObservation(sessionId, observation)
    const existingExample = await client.query(`SELECT id FROM autotrader.setup_examples WHERE id = $1`, [example.id])
    if (existingExample.rowCount) return
    const existingResult = await client.query<ScorecardRow>(`SELECT * FROM autotrader.scorecards WHERE key = $1`, [key])
    const updated = updateScorecardWithObservation(
      existingResult.rows[0] ? mapScorecard(existingResult.rows[0]) : null,
      sessionId,
      observation,
    )
    await client.query(
      `INSERT INTO autotrader.scorecards (
        key, symbol, setup_type, setup_grade, regime, time_bucket, sample_size, wins, losses, scratches,
        rejected_valid, rejected_invalid, total_realized_r, avg_realized_r, avg_hold_seconds, avg_mfe_r, avg_mae_r,
        last_outcome, confidence, updated_at, last_session_id
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::timestamptz, $21
      )
      ON CONFLICT (key) DO UPDATE SET
        sample_size = EXCLUDED.sample_size,
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        scratches = EXCLUDED.scratches,
        rejected_valid = EXCLUDED.rejected_valid,
        rejected_invalid = EXCLUDED.rejected_invalid,
        total_realized_r = EXCLUDED.total_realized_r,
        avg_realized_r = EXCLUDED.avg_realized_r,
        avg_hold_seconds = EXCLUDED.avg_hold_seconds,
        avg_mfe_r = EXCLUDED.avg_mfe_r,
        avg_mae_r = EXCLUDED.avg_mae_r,
        last_outcome = EXCLUDED.last_outcome,
        confidence = EXCLUDED.confidence,
        updated_at = EXCLUDED.updated_at,
        last_session_id = EXCLUDED.last_session_id`,
      [
        updated.key,
        updated.symbol,
        updated.setupType,
        updated.setupGrade,
        updated.regime,
        updated.timeBucket,
        updated.sampleSize,
        updated.wins,
        updated.losses,
        updated.scratches,
        updated.rejectedValid,
        updated.rejectedInvalid,
        updated.totalRealizedR,
        updated.avgRealizedR,
        updated.avgHoldSeconds,
        updated.avgMfeR,
        updated.avgMaeR,
        updated.lastOutcome,
        updated.confidence,
        updated.updatedAt,
        sessionId,
      ],
    )
    await client.query(
      `INSERT INTO autotrader.setup_examples (
        id, scorecard_key, session_id, ticket_id, symbol, setup_type, setup_grade, regime, time_bucket, outcome,
        realized_r, notes, mistake_tags, payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
      ON CONFLICT (id) DO NOTHING`,
      [
        example.id,
        example.scorecardKey,
        example.sessionId,
        example.ticketId,
        example.symbol,
        example.setupType,
        example.setupGrade,
        example.regime,
        example.timeBucket,
        example.outcome,
        example.realizedR,
        example.notes,
        JSON.stringify(example.mistakeTags),
        toJson(example.payload),
      ],
    )
  }

  private ensureSchema() {
    this.schemaPromise ??= this.createSchema()
    return this.schemaPromise
  }

  private async createSchema() {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS autotrader;

      CREATE TABLE IF NOT EXISTS autotrader.sessions (
        id text PRIMARY KEY,
        agent_run_name text NOT NULL UNIQUE,
        mode text NOT NULL,
        trading_date text NOT NULL,
        account_id text,
        goal_equity numeric NOT NULL,
        opening_equity numeric,
        closing_equity numeric,
        realized_pnl numeric,
        max_drawdown numeric,
        market_open_at timestamptz NOT NULL,
        market_close_at timestamptz NOT NULL,
        analysis_head text,
        analysis_context_hash text,
        started_at timestamptz NOT NULL DEFAULT now(),
        finalized_at timestamptz,
        terminal_reason text,
        summary jsonb NOT NULL DEFAULT '{}'::jsonb
      );

      ALTER TABLE autotrader.sessions
        ADD COLUMN IF NOT EXISTS opening_equity numeric,
        ADD COLUMN IF NOT EXISTS closing_equity numeric,
        ADD COLUMN IF NOT EXISTS realized_pnl numeric,
        ADD COLUMN IF NOT EXISTS max_drawdown numeric;

      CREATE TABLE IF NOT EXISTS autotrader.status (
        session_id text PRIMARY KEY REFERENCES autotrader.sessions(id) ON DELETE CASCADE,
        cycle integer NOT NULL,
        phase text NOT NULL,
        equity numeric,
        buying_power numeric,
        daytrade_buying_power numeric,
        gross_exposure numeric,
        net_exposure numeric,
        realized_pnl numeric,
        unrealized_pnl numeric,
        current_action text NOT NULL,
        blocker text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS autotrader.events (
        session_id text NOT NULL REFERENCES autotrader.sessions(id) ON DELETE CASCADE,
        seq integer NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        event_type text NOT NULL,
        symbol text,
        setup_type text,
        setup_grade text,
        severity text NOT NULL DEFAULT 'info',
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (session_id, seq)
      );

      CREATE TABLE IF NOT EXISTS autotrader.trade_tickets (
        id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES autotrader.sessions(id) ON DELETE CASCADE,
        idempotency_key text NOT NULL,
        symbol text NOT NULL,
        instrument text NOT NULL,
        side text NOT NULL,
        setup_type text NOT NULL,
        setup_grade text NOT NULL,
        fat_pitch boolean NOT NULL DEFAULT false,
        regime text NOT NULL,
        time_bucket text,
        thesis text NOT NULL,
        entry_trigger text NOT NULL,
        invalidation text NOT NULL,
        entry_limit_price numeric,
        stop_price numeric,
        target_price numeric,
        expected_r numeric,
        max_loss_amount numeric,
        risk_dollars numeric,
        planned_quantity numeric,
        protection_type text NOT NULL,
        broker_order_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL,
        no_trade_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (session_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS autotrader.risk_checks (
        id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES autotrader.sessions(id) ON DELETE CASCADE,
        ticket_id text REFERENCES autotrader.trade_tickets(id) ON DELETE SET NULL,
        idempotency_key text NOT NULL,
        check_type text NOT NULL,
        passed boolean NOT NULL,
        reason text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (session_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS autotrader.orders (
        client_order_id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES autotrader.sessions(id) ON DELETE CASCADE,
        ticket_id text REFERENCES autotrader.trade_tickets(id) ON DELETE SET NULL,
        broker_order_id text,
        symbol text NOT NULL,
        instrument text NOT NULL,
        side text NOT NULL,
        quantity numeric NOT NULL,
        order_type text NOT NULL,
        order_class text,
        limit_price numeric,
        stop_price numeric,
        take_profit_limit_price numeric,
        stop_loss_stop_price numeric,
        stop_loss_limit_price numeric,
        status text NOT NULL,
        reject_reason text,
        broker_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      ALTER TABLE autotrader.orders
        ADD COLUMN IF NOT EXISTS stop_loss_limit_price numeric;

      CREATE TABLE IF NOT EXISTS autotrader.fills (
        broker_fill_id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES autotrader.sessions(id) ON DELETE CASCADE,
        client_order_id text NOT NULL REFERENCES autotrader.orders(client_order_id) ON DELETE CASCADE,
        symbol text NOT NULL,
        side text NOT NULL,
        quantity numeric NOT NULL,
        price numeric NOT NULL,
        filled_at timestamptz NOT NULL,
        broker_payload jsonb NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE TABLE IF NOT EXISTS autotrader.position_snapshots (
        id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES autotrader.sessions(id) ON DELETE CASCADE,
        symbol text NOT NULL,
        quantity numeric NOT NULL,
        market_value numeric,
        average_entry_price numeric,
        unrealized_pnl numeric,
        captured_at timestamptz NOT NULL DEFAULT now(),
        broker_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (session_id, symbol, captured_at)
      );

      CREATE TABLE IF NOT EXISTS autotrader.scorecards (
        key text PRIMARY KEY,
        symbol text,
        setup_type text NOT NULL,
        setup_grade text NOT NULL,
        regime text NOT NULL,
        time_bucket text NOT NULL,
        sample_size integer NOT NULL DEFAULT 0,
        wins integer NOT NULL DEFAULT 0,
        losses integer NOT NULL DEFAULT 0,
        scratches integer NOT NULL DEFAULT 0,
        rejected_valid integer NOT NULL DEFAULT 0,
        rejected_invalid integer NOT NULL DEFAULT 0,
        total_realized_r numeric NOT NULL DEFAULT 0,
        avg_realized_r numeric NOT NULL DEFAULT 0,
        avg_hold_seconds numeric,
        avg_mfe_r numeric,
        avg_mae_r numeric,
        last_outcome text,
        confidence numeric NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_session_id text REFERENCES autotrader.sessions(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS autotrader.setup_examples (
        id text PRIMARY KEY,
        scorecard_key text NOT NULL REFERENCES autotrader.scorecards(key) ON DELETE CASCADE,
        session_id text NOT NULL REFERENCES autotrader.sessions(id) ON DELETE CASCADE,
        ticket_id text REFERENCES autotrader.trade_tickets(id) ON DELETE SET NULL,
        symbol text,
        setup_type text NOT NULL,
        setup_grade text NOT NULL,
        regime text NOT NULL,
        time_bucket text NOT NULL,
        outcome text NOT NULL,
        realized_r numeric,
        notes text,
        mistake_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'autotrader_trade_tickets_grade_check'
            AND conrelid = 'autotrader.trade_tickets'::regclass
        ) THEN
          ALTER TABLE autotrader.trade_tickets
            ADD CONSTRAINT autotrader_trade_tickets_grade_check
            CHECK (setup_grade IN ('A+', 'A', 'B', 'C', 'blocked'));
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'autotrader_trade_tickets_positive_risk_check'
            AND conrelid = 'autotrader.trade_tickets'::regclass
        ) THEN
          ALTER TABLE autotrader.trade_tickets
            ADD CONSTRAINT autotrader_trade_tickets_positive_risk_check
            CHECK (
              (max_loss_amount IS NULL OR max_loss_amount >= 0)
              AND (risk_dollars IS NULL OR risk_dollars >= 0)
            );
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS autotrader_sessions_started_at_idx ON autotrader.sessions (started_at DESC);
      CREATE INDEX IF NOT EXISTS autotrader_sessions_trading_date_idx
        ON autotrader.sessions (trading_date DESC);
      CREATE INDEX IF NOT EXISTS autotrader_status_phase_idx ON autotrader.status (phase, updated_at DESC);
      CREATE INDEX IF NOT EXISTS autotrader_events_session_seq_idx ON autotrader.events (session_id, seq);
      CREATE INDEX IF NOT EXISTS autotrader_events_session_time_idx
        ON autotrader.events (session_id, occurred_at);
      CREATE INDEX IF NOT EXISTS autotrader_events_type_time_idx
        ON autotrader.events (event_type, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS autotrader_events_symbol_time_idx
        ON autotrader.events (symbol, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS autotrader_events_setup_idx
        ON autotrader.events (setup_type, setup_grade, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS autotrader_trade_tickets_session_idx ON autotrader.trade_tickets (session_id, created_at);
      CREATE INDEX IF NOT EXISTS autotrader_orders_session_idx ON autotrader.orders (session_id, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS autotrader_orders_broker_order_id_idx
        ON autotrader.orders (broker_order_id)
        WHERE broker_order_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS autotrader_fills_session_idx ON autotrader.fills (session_id, filled_at);
      CREATE INDEX IF NOT EXISTS autotrader_positions_session_idx ON autotrader.position_snapshots (session_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS autotrader_scorecards_lookup_idx
        ON autotrader.scorecards (setup_type, setup_grade, regime, time_bucket, updated_at DESC);
      CREATE INDEX IF NOT EXISTS autotrader_setup_examples_scorecard_idx
        ON autotrader.setup_examples (scorecard_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS autotrader_setup_examples_session_idx
        ON autotrader.setup_examples (session_id, created_at DESC);
    `)
  }
}

let autotraderStoreSingleton: AutotraderStore | null = null

export const createInMemoryAutotraderStore = (): AutotraderStore => new InMemoryAutotraderStore()

export const getAutotraderStore = () => {
  if (autotraderStoreSingleton) return autotraderStoreSingleton

  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl || process.env.SYNTHESIS_STORAGE === 'memory') {
    autotraderStoreSingleton = createInMemoryAutotraderStore()
    return autotraderStoreSingleton
  }

  autotraderStoreSingleton = new PostgresAutotraderStore(databaseUrl)
  return autotraderStoreSingleton
}

export const setAutotraderStoreForTests = (store: AutotraderStore | null) => {
  autotraderStoreSingleton = store
}
