import { z } from 'zod'

const NumericStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => Number.isFinite(Number(value)), 'must be numeric')

const OptionalNumericStringSchema = NumericStringSchema.optional()
const PayloadSchema = z.record(z.string(), z.unknown()).default({})
const TagsSchema = z.array(z.string().trim().min(1).max(80)).max(32).default([])

export const AutotraderSessionModeSchema = z.enum([
  'market_session',
  'market_open',
  'dry_run',
  'paper_smoke',
  'scorecard_readback',
])
export const AutotraderPhaseSchema = z.enum([
  'preflight',
  'scan',
  'ticket',
  'risk_check',
  'order',
  'manage',
  'reconcile',
  'finalize',
  'blocked',
  'idle',
  'no_trade',
])
export const AutotraderInstrumentSchema = z.enum(['stock', 'etf', 'option', 'crypto', 'other'])
export const AutotraderSideSchema = z.enum([
  'buy',
  'sell',
  'sell_short',
  'buy_to_cover',
  'buy_to_open',
  'buy_to_close',
  'sell_to_open',
  'sell_to_close',
])
export const AutotraderSetupGradeSchema = z.enum(['A+', 'A', 'B', 'C', 'blocked'])
export const AutotraderSeveritySchema = z.enum(['debug', 'info', 'warn', 'error'])
export const AutotraderTicketStatusSchema = z.enum(['candidate', 'validated', 'blocked', 'ordered', 'filled', 'closed'])
export const AutotraderOrderStatusSchema = z.enum([
  'planned',
  'submitted',
  'accepted',
  'partially_filled',
  'filled',
  'canceled',
  'rejected',
  'expired',
  'reconciled',
  'replaced',
])
export const AutotraderOutcomeSchema = z.enum(['win', 'loss', 'scratch', 'rejected_valid', 'rejected_invalid'])
export const AutotraderTerminalReasonSchema = z.enum([
  'target_reached',
  'market_closed',
  'dry_run_complete',
  'scorecard_readback_waiting',
  'scorecard_readback_complete',
  'hard_stop',
])

export const AutotraderStartSessionInputSchema = z
  .object({
    agentRunName: z.string().trim().min(1).max(180),
    mode: AutotraderSessionModeSchema.default('market_session'),
    tradingDate: z.string().trim().min(1).max(40),
    accountId: z.string().trim().min(1).max(180).optional(),
    goalEquity: NumericStringSchema.default('500000'),
    openingEquity: OptionalNumericStringSchema,
    marketOpenAt: z.string().trim().min(1).max(80),
    marketCloseAt: z.string().trim().min(1).max(80),
    analysisHead: z.string().trim().min(1).max(120).optional(),
    analysisContextHash: z.string().trim().min(1).max(160).optional(),
  })
  .strict()

export const AutotraderUpsertStatusInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    cycle: z.coerce.number().int().min(0),
    phase: AutotraderPhaseSchema,
    equity: OptionalNumericStringSchema,
    buyingPower: OptionalNumericStringSchema,
    daytradeBuyingPower: OptionalNumericStringSchema,
    grossExposure: OptionalNumericStringSchema,
    netExposure: OptionalNumericStringSchema,
    realizedPnl: OptionalNumericStringSchema,
    unrealizedPnl: OptionalNumericStringSchema,
    currentAction: z.string().trim().min(1).max(500),
    blocker: z.string().trim().min(1).max(1_000).nullable().optional(),
    payload: PayloadSchema,
  })
  .strict()

export const AutotraderAppendEventInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    seq: z.coerce.number().int().min(0),
    occurredAt: z.string().trim().min(1).max(80).optional(),
    eventType: z.string().trim().min(1).max(120),
    symbol: z.string().trim().min(1).max(32).optional(),
    setupType: z.string().trim().min(1).max(120).optional(),
    setupGrade: AutotraderSetupGradeSchema.optional(),
    severity: AutotraderSeveritySchema.default('info'),
    payload: PayloadSchema,
  })
  .strict()

export const AutotraderCreateTradeTicketInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1).max(240),
    symbol: z.string().trim().min(1).max(32),
    instrument: AutotraderInstrumentSchema,
    side: AutotraderSideSchema,
    setupType: z.string().trim().min(1).max(120),
    setupGrade: AutotraderSetupGradeSchema,
    fatPitch: z.boolean().default(false),
    regime: z.string().trim().min(1).max(120),
    timeBucket: z.string().trim().min(1).max(80).optional(),
    thesis: z.string().trim().min(1).max(2_000),
    entryTrigger: z.string().trim().min(1).max(1_200),
    invalidation: z.string().trim().min(1).max(1_200),
    entryLimitPrice: OptionalNumericStringSchema,
    stopPrice: OptionalNumericStringSchema,
    targetPrice: OptionalNumericStringSchema,
    expectedR: OptionalNumericStringSchema,
    maxLossAmount: OptionalNumericStringSchema,
    riskDollars: OptionalNumericStringSchema,
    plannedQuantity: OptionalNumericStringSchema,
    protectionType: z.string().trim().min(1).max(80),
    brokerOrderPlan: PayloadSchema,
    status: AutotraderTicketStatusSchema.default('candidate'),
    noTradeReason: z.string().trim().min(1).max(1_000).nullable().optional(),
  })
  .strict()

export const AutotraderRecordRiskCheckInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    ticketId: z.string().trim().min(1).optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    checkType: z.string().trim().min(1).max(120),
    passed: z.boolean(),
    reason: z.string().trim().min(1).max(1_200).optional(),
    payload: PayloadSchema,
  })
  .strict()

export const AutotraderRecordOrderInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    ticketId: z.string().trim().min(1).optional(),
    clientOrderId: z.string().trim().min(1).max(128),
    brokerOrderId: z.string().trim().min(1).max(240).nullable().optional(),
    symbol: z.string().trim().min(1).max(32),
    instrument: AutotraderInstrumentSchema,
    side: AutotraderSideSchema,
    quantity: NumericStringSchema,
    orderType: z.string().trim().min(1).max(80),
    orderClass: z.string().trim().min(1).max(80).optional(),
    limitPrice: OptionalNumericStringSchema,
    stopPrice: OptionalNumericStringSchema,
    takeProfitLimitPrice: OptionalNumericStringSchema,
    stopLossStopPrice: OptionalNumericStringSchema,
    stopLossLimitPrice: OptionalNumericStringSchema,
    status: AutotraderOrderStatusSchema,
    rejectReason: z.string().trim().min(1).max(1_000).nullable().optional(),
    brokerPayload: PayloadSchema,
  })
  .strict()

export const AutotraderRecordFillInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    clientOrderId: z.string().trim().min(1).max(128),
    brokerOrderId: z.string().trim().min(1).max(240).optional(),
    brokerFillId: z.string().trim().min(1).max(240),
    symbol: z.string().trim().min(1).max(32),
    side: AutotraderSideSchema,
    quantity: NumericStringSchema,
    price: NumericStringSchema,
    filledAt: z.string().trim().min(1).max(80),
    brokerPayload: PayloadSchema,
  })
  .strict()

export const AutotraderRecordPositionSnapshotInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    symbol: z.string().trim().min(1).max(32),
    quantity: NumericStringSchema,
    marketValue: OptionalNumericStringSchema,
    averageEntryPrice: OptionalNumericStringSchema,
    unrealizedPnl: OptionalNumericStringSchema,
    capturedAt: z.string().trim().min(1).max(80),
    brokerPayload: PayloadSchema,
  })
  .strict()

export const AutotraderScorecardObservationSchema = z
  .object({
    ticketId: z.string().trim().min(1).optional(),
    symbol: z.string().trim().min(1).max(32).optional(),
    setupType: z.string().trim().min(1).max(120),
    setupGrade: AutotraderSetupGradeSchema,
    regime: z.string().trim().min(1).max(120),
    timeBucket: z.string().trim().min(1).max(80),
    outcome: AutotraderOutcomeSchema,
    realizedR: OptionalNumericStringSchema,
    holdSeconds: OptionalNumericStringSchema,
    mfeR: OptionalNumericStringSchema,
    maeR: OptionalNumericStringSchema,
    mistakeTags: TagsSchema,
    notes: z.string().trim().min(1).max(1_200).optional(),
    payload: PayloadSchema,
  })
  .strict()

export const AutotraderFinalizeSessionInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    terminalReason: AutotraderTerminalReasonSchema,
    openingEquity: OptionalNumericStringSchema,
    closingEquity: OptionalNumericStringSchema,
    realizedPnl: OptionalNumericStringSchema,
    maxDrawdown: OptionalNumericStringSchema,
    summary: PayloadSchema,
    scorecardObservations: z.array(AutotraderScorecardObservationSchema).max(200).default([]),
  })
  .strict()

export const AutotraderGetScorecardInputSchema = z
  .object({
    symbol: z.string().trim().min(1).max(32).optional(),
    setupType: z.string().trim().min(1).max(120).optional(),
    setupGrade: AutotraderSetupGradeSchema.optional(),
    regime: z.string().trim().min(1).max(120).optional(),
    timeBucket: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()

export const AutotraderListSessionsInputSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()

export type AutotraderStartSessionInput = z.infer<typeof AutotraderStartSessionInputSchema>
export type AutotraderUpsertStatusInput = z.infer<typeof AutotraderUpsertStatusInputSchema>
export type AutotraderAppendEventInput = z.infer<typeof AutotraderAppendEventInputSchema>
export type AutotraderCreateTradeTicketInput = z.infer<typeof AutotraderCreateTradeTicketInputSchema>
export type AutotraderRecordRiskCheckInput = z.infer<typeof AutotraderRecordRiskCheckInputSchema>
export type AutotraderRecordOrderInput = z.infer<typeof AutotraderRecordOrderInputSchema>
export type AutotraderRecordFillInput = z.infer<typeof AutotraderRecordFillInputSchema>
export type AutotraderRecordPositionSnapshotInput = z.infer<typeof AutotraderRecordPositionSnapshotInputSchema>
export type AutotraderFinalizeSessionInput = z.infer<typeof AutotraderFinalizeSessionInputSchema>
export type AutotraderGetScorecardInput = z.infer<typeof AutotraderGetScorecardInputSchema>
export type AutotraderScorecardObservation = z.infer<typeof AutotraderScorecardObservationSchema>

export type AutotraderSession = {
  id: string
  agentRunName: string
  mode: z.infer<typeof AutotraderSessionModeSchema>
  tradingDate: string
  accountId: string | null
  goalEquity: string
  openingEquity: string | null
  closingEquity: string | null
  realizedPnl: string | null
  maxDrawdown: string | null
  marketOpenAt: string
  marketCloseAt: string
  analysisHead: string | null
  analysisContextHash: string | null
  startedAt: string
  finalizedAt: string | null
  terminalReason: string | null
  summary: Record<string, unknown>
}

export type AutotraderStatus = {
  sessionId: string
  cycle: number
  phase: z.infer<typeof AutotraderPhaseSchema>
  equity: string | null
  buyingPower: string | null
  daytradeBuyingPower: string | null
  grossExposure: string | null
  netExposure: string | null
  realizedPnl: string | null
  unrealizedPnl: string | null
  currentAction: string
  blocker: string | null
  payload: Record<string, unknown>
  updatedAt: string
}

export type AutotraderEvent = {
  sessionId: string
  seq: number
  occurredAt: string
  eventType: string
  symbol: string | null
  setupType: string | null
  setupGrade: z.infer<typeof AutotraderSetupGradeSchema> | null
  severity: z.infer<typeof AutotraderSeveritySchema>
  payload: Record<string, unknown>
}

export type AutotraderTradeTicket = {
  id: string
  sessionId: string
  idempotencyKey: string
  symbol: string
  instrument: z.infer<typeof AutotraderInstrumentSchema>
  side: z.infer<typeof AutotraderSideSchema>
  setupType: string
  setupGrade: z.infer<typeof AutotraderSetupGradeSchema>
  fatPitch: boolean
  regime: string
  timeBucket: string | null
  thesis: string
  entryTrigger: string
  invalidation: string
  entryLimitPrice: string | null
  stopPrice: string | null
  targetPrice: string | null
  expectedR: string | null
  maxLossAmount: string | null
  riskDollars: string | null
  plannedQuantity: string | null
  protectionType: string
  brokerOrderPlan: Record<string, unknown>
  status: z.infer<typeof AutotraderTicketStatusSchema>
  noTradeReason: string | null
  createdAt: string
  updatedAt: string
}

export type AutotraderRiskCheck = {
  id: string
  sessionId: string
  ticketId: string | null
  idempotencyKey: string
  checkType: string
  passed: boolean
  reason: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export type AutotraderOrder = {
  sessionId: string
  ticketId: string | null
  clientOrderId: string
  brokerOrderId: string | null
  symbol: string
  instrument: z.infer<typeof AutotraderInstrumentSchema>
  side: z.infer<typeof AutotraderSideSchema>
  quantity: string
  orderType: string
  orderClass: string | null
  limitPrice: string | null
  stopPrice: string | null
  takeProfitLimitPrice: string | null
  stopLossStopPrice: string | null
  stopLossLimitPrice: string | null
  status: z.infer<typeof AutotraderOrderStatusSchema>
  rejectReason: string | null
  brokerPayload: Record<string, unknown>
  updatedAt: string
}

export type AutotraderFill = {
  sessionId: string
  clientOrderId: string
  brokerFillId: string
  symbol: string
  side: z.infer<typeof AutotraderSideSchema>
  quantity: string
  price: string
  filledAt: string
  brokerPayload: Record<string, unknown>
}

export type AutotraderPositionSnapshot = {
  id: string
  sessionId: string
  symbol: string
  quantity: string
  marketValue: string | null
  averageEntryPrice: string | null
  unrealizedPnl: string | null
  capturedAt: string
  brokerPayload: Record<string, unknown>
}

export type AutotraderScorecard = {
  key: string
  symbol: string | null
  setupType: string
  setupGrade: z.infer<typeof AutotraderSetupGradeSchema>
  regime: string
  timeBucket: string
  sampleSize: number
  wins: number
  losses: number
  scratches: number
  rejectedValid: number
  rejectedInvalid: number
  totalRealizedR: string
  avgRealizedR: string
  avgHoldSeconds: string | null
  avgMfeR: string | null
  avgMaeR: string | null
  lastOutcome: z.infer<typeof AutotraderOutcomeSchema> | null
  confidence: string
  updatedAt: string
  lastSessionId: string | null
}

export type AutotraderSetupExample = {
  id: string
  scorecardKey: string
  sessionId: string
  ticketId: string | null
  symbol: string | null
  setupType: string
  setupGrade: z.infer<typeof AutotraderSetupGradeSchema>
  regime: string
  timeBucket: string
  outcome: z.infer<typeof AutotraderOutcomeSchema>
  realizedR: string | null
  notes: string | null
  mistakeTags: string[]
  payload: Record<string, unknown>
  createdAt: string
}

export type AutotraderSessionDetail = {
  session: AutotraderSession
  status: AutotraderStatus | null
  events: AutotraderEvent[]
  tradeTickets: AutotraderTradeTicket[]
  riskChecks: AutotraderRiskCheck[]
  orders: AutotraderOrder[]
  fills: AutotraderFill[]
  positionSnapshots: AutotraderPositionSnapshot[]
  scorecards: AutotraderScorecard[]
  setupExamples: AutotraderSetupExample[]
}
