import { Schema } from 'effect'

import { OrderSide, OrderStatus } from '../src/execution/contracts'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema as Count,
  PositiveFiniteSchema,
  Sha256Schema,
  SignalRowSymbolSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcSourceTimestampSchema as At,
} from '../src/schemas'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { Profile, universe } from '../src/strategy/macro-etf-core/policy'
import { Account, Bar, Orders, Positions, Side } from './macro-canary-runner/alpaca'
import { Mode, TimeInForce } from './macro-canary-runner/contract'
import { etfs, historyLength, wave5dRevision } from './macro-canary-runner/signals'
import { RunnerProfile } from './macro-etf-core-runner/contract'

export const Micros = Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9]\d{0,39})$/))
export const UnsignedMicros = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d{0,39})$/))
const Decimal = Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/))
const Id = StrictNonEmptyStringSchema
const Date = IsoDateSchema
const Finite = Schema.Finite
const Bool = Schema.Boolean
const Weight = Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 + 1e-9 }))
const ids = Schema.Array(Id)
const symbols = Schema.Array(SymbolSchema)
const money = Schema.NullOr(Micros)
const price = Schema.NullOr(UnsignedMicros)
const bps = Schema.NullOr(Finite)
const calendar = { openAt: At, closeAt: At }
export const SessionCalendar = Schema.Struct({ date: Date, ...calendar })

export enum AuditVerdict {
  Pass = 'PASS',
  Fail = 'FAIL',
  Insufficient = 'INSUFFICIENT_EVIDENCE',
}

export enum AuditAlert {
  NoCut = 'NO_ADMISSIBLE_CUT',
  CloseData = 'CLOSE_MARKET_DATA_UNAVAILABLE',
  CloseExpired = 'CLOSE_WINDOW_EXPIRED',
  Gap = 'STOP_LIMIT_GAP_THROUGH',
  TimedExit = 'MISSED_TIMED_EXIT',
  RegularClose = 'REGULAR_CLOSE_BREACH',
  LateActivity = 'POST_REGULAR_CLOSE_ACTIVITY',
  Stranded = 'NON_FLAT_EOD',
  Reconciliation = 'RECONCILIATION_DISCREPANCY',
  Working = 'WORKING_ORDERS_AT_CUT',
}

const sleeve = Schema.Union([Schema.Enum(IntradayAlphaPhase), Schema.Literal('UNATTRIBUTED')])
const distribution = { samples: Count, meanBps: bps, medianBps: bps }
const Distribution = Schema.Struct(distribution)
const metrics = {
  fills: Count,
  realizedMicros: money,
  eodUnrealizedMicros: money,
  directFeesMicros: UnsignedMicros,
  unallocatedPostedFeesMicros: Micros,
  netRealizedMicros: money,
  tradedNotionalMicros: UnsignedMicros,
  annualizedTurnoverContribution: bps,
  entries: Count,
  entryFillRate: bps,
  entryFullFillRate: bps,
  collarMissRate: bps,
  entryVsSignal: Distribution,
  entryVsReference: Distribution,
  entryVsLimit: Distribution,
  protectiveStops: Count,
  observedStopCrosses: Count,
  stopLimitFillRate: bps,
  gapThroughIncidents: Count,
  timedExitBreaches: Count,
  regularCloseBreaches: Count,
  nonFlatEodPositions: Count,
  roundTrip: Distribution,
  unmeasuredRoundTrips: Count,
}
const Position = Schema.Struct({
  symbol: SymbolSchema,
  sleeve,
  regularCloseSleeve: sleeve,
  openingQuantity: Decimal,
  regularCloseQuantity: Schema.NullOr(Decimal),
  lastLedgerQuantity: Decimal,
  lastBrokerQuantity: Schema.NullOr(Decimal),
  eodUnrealizedMicros: money,
})
const Entry = Schema.Struct({
  id: Id,
  sleeve: Schema.Enum(IntradayAlphaPhase),
  symbol: SymbolSchema,
  side: Schema.Enum(OrderSide),
  quantityAtoms: UnsignedMicros,
  signalMicros: price,
  referenceMicros: price,
  holdMinutes: Schema.NullOr(Count),
  orderIds: ids,
  filledQuantityAtoms: UnsignedMicros,
  fullyFilled: Bool,
  collarMissed: Bool,
  versusSignalBps: bps,
  versusReferenceBps: bps,
  versusLimitBps: bps,
})
enum Feed {
  Iex = 'iex',
  Sip = 'sip',
}
enum GapSource {
  Quote = 'QUOTE',
  PositionMark = 'POSITION_MARK',
}
const Stop = Schema.Struct({
  orderId: Id,
  symbol: SymbolSchema,
  sleeve,
  status: Schema.Enum(OrderStatus),
  terminalAt: Schema.NullOr(At),
  stopMicros: price,
  limitMicros: price,
  filledQuantityAtoms: UnsignedMicros,
  fullyFilled: Bool,
  observedQuotes: Count,
  stopCrossed: Bool,
  gapThrough: Schema.NullOr(
    Schema.Union([
      Schema.Struct({
        source: Schema.Enum(GapSource).check(Schema.makeFilter((source) => source === GapSource.Quote)),
        at: At,
        feed: Schema.Enum(Feed),
        oppositePriceMicros: UnsignedMicros,
        firstObservedCrossAlreadyPastLimit: Bool,
      }),
      Schema.Struct({
        source: Schema.Enum(GapSource).check(Schema.makeFilter((source) => source === GapSource.PositionMark)),
        at: At,
        markPriceMicros: UnsignedMicros,
      }),
    ]),
  ),
})
const AuditSession = Schema.Struct({
  date: Date,
  asOf: At,
  calendar: Schema.NullOr(Schema.Struct(calendar)),
  verdict: Schema.Enum(AuditVerdict),
  metrics: Schema.Struct(metrics),
  bySleeve: Schema.Array(Schema.Struct({ sleeve, ...metrics })),
  bySymbol: Schema.Array(Schema.Struct({ symbol: SymbolSchema, ...metrics })),
  slippageGate: Schema.Struct({
    cohort: Schema.Literal('B0 (QQQ+SMH 1.4x)'),
    unmatchedFilledEntries: Count,
    ...distribution,
    roundTripBps: Schema.optionalKey(Schema.Array(Finite.check(Schema.isBetween({ minimum: -1e50, maximum: 1e50 })))),
    unmeasuredRoundTrips: Count,
    promotionBps: Schema.Literal(2.5),
    promotion: Schema.Enum(AuditVerdict),
    fullPeriodBreakevenBps: Schema.Literal(11.2),
    fullPeriodBreakeven: Schema.Enum(AuditVerdict),
    recentBreakevenBps: Schema.Literal(15.6),
    recentBreakeven: Schema.Enum(AuditVerdict),
  }),
  marketDrift: Schema.Array(
    Schema.Struct({
      symbol: SymbolSchema,
      ...distribution,
      absolute: Distribution,
      unmatchedMinutes: Count,
      conflictingMinutes: Count,
    }),
  ),
  alerts: Schema.Array(Schema.Enum(AuditAlert)),
  controller: Schema.Struct({
    passes: Count,
    noAdmissibleCut: Count,
    closeMarketDataUnavailable: Count,
    closeWindowExpired: Count,
  }),
  timedExitBreaches: Schema.Array(
    Schema.Struct({ entryId: Id, sleeve, symbol: SymbolSchema, dueAt: At, flatAt: Schema.NullOr(At) }),
  ),
  regularCloseBreaches: Schema.Array(Position),
  eodNonFlat: Schema.Array(Position),
  postCloseOrderIds: ids,
  postCloseFillIds: ids,
  evidence: Schema.Struct({
    openingEquityMicros: price,
    pendingFees: Count,
    missingFillEvents: Count,
    unresolvedFills: Count,
    unverifiedDecisions: Count,
    unresolvedOrders: Count,
    eodEvidence: Bool,
    positionEvidence: Bool,
    brokerPositionCount: Schema.NullOr(Count),
    reconciliationAt: Schema.NullOr(At),
    positionsAt: Schema.NullOr(At),
    reconciliationExact: Schema.NullOr(Bool),
  }),
  positions: Schema.Array(Position),
  entries: Schema.Array(Entry),
  protectiveStops: Schema.Array(Stop),
})
export const AuditReceipt = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.live-profitability-audit.v1'),
  sessions: Schema.Array(AuditSession),
})
export type AuditSession = typeof AuditSession.Type

const uniqueSymbols = (rows: readonly { readonly symbol: string }[]) =>
  new Set(rows.map(({ symbol }) => symbol)).size === rows.length
const canaryVector = (range: typeof Finite) =>
  Schema.Array(Schema.Struct({ symbol: Schema.Literals(etfs), value: range })).check(
    Schema.makeFilter((rows) => rows.length === etfs.length && uniqueSymbols(rows), {
      expected: 'complete unique canary strategy symbol vector',
    }),
  )
const coreTargets = Schema.Array(Schema.Struct({ symbol: Schema.Literals(universe), weight: Weight })).check(
  Schema.makeFilter((rows) => rows.length === universe.length && uniqueSymbols(rows), {
    expected: 'complete unique macro ETF core targets',
  }),
)
const canaryTargets = Schema.Array(Schema.Struct({ symbol: Schema.Literals(etfs), weight: Weight })).check(
  Schema.makeFilter((rows) => rows.length === etfs.length && uniqueSymbols(rows), {
    expected: 'complete unique macro canary targets',
  }),
)
const LimitPrice = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d{0,9})\.\d{2}$/),
  Schema.makeFilter((value) => Number(value) > 0),
)
const Order = Schema.Struct({
  request: Schema.Struct({
    symbol: SymbolSchema,
    side: Schema.Enum(Side),
    qty: Schema.String.check(Schema.isPattern(/^[1-9]\d{0,15}$/)),
    type: Schema.Literal('limit'),
    time_in_force: Schema.Enum(TimeInForce),
    limit_price: LimitPrice,
    extended_hours: Schema.Literal(false),
    client_order_id: Id,
  }),
  referenceNotionalMicros: Count,
  limitNotionalCents: Count,
})

const common = {
  broker: Schema.Literal('alpaca-paper'),
  signalSession: Date,
  signalCloseAt: At,
  executionSession: Date,
  executionOpenAt: At,
  tif: Schema.Enum(TimeInForce),
  barSha256: Sha256Schema,
  rawSizingBars: Schema.Struct({
    feed: Schema.Literal(Feed.Sip),
    timeframe: Schema.Literal('1Day'),
    adjustment: Schema.Literal('raw'),
    rows: Schema.Array(Schema.Struct({ symbol: SymbolSchema, bar: Bar })),
  }),
  reconciliation: Schema.Struct({ account: Account, positions: Positions, openOrders: Orders }),
  mode: Schema.Enum(Mode),
  timestamp: At,
  planSha256: Sha256Schema,
}
const commonPlan = {
  blocked: Schema.NullOr(Id),
  rebalanceDue: Bool,
  budgetCents: Count,
  cashCents: Count,
  buyingPowerCents: Count,
  equityCents: Count,
  managedGrossCents: Count,
  overnightCapCents: Count,
  intradayCapCents: Count,
  maximumProjectedGrossCents: Count,
  remainingIntradayGrossCents: Count,
  buyLimitNotionalCents: Count,
  orders: Schema.Array(Order),
}
const signalBars = {
  feed: Schema.Literal(Feed.Sip),
  timeframe: Schema.Literal('1Day'),
  adjustment: Schema.Literal('all'),
}
export const CoreReceipt = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.macro-etf-core-rebalance-receipt.v1'),
  ...common,
  profile: Schema.Enum(RunnerProfile),
  configuredExclusions: symbols,
  configuredBudgetCents: Count,
  signalBars: Schema.Struct({
    ...signalBars,
    sessions: Count,
    snapshotSha256: Sha256Schema,
    missingCandidates: symbols,
  }),
  allocation: Schema.Struct({
    components: Schema.Array(
      Schema.Struct({
        profile: Schema.Enum(Profile),
        policyHash: Sha256Schema,
        signal: Schema.NullOr(
          Schema.Struct({
            policyHash: Sha256Schema,
            signalDate: Date,
            signalCloseAt: Count,
            executionDate: Date,
            executionOpenAt: Count,
            weights: Schema.Array(Weight).check(
              Schema.isMinLength(universe.length),
              Schema.isMaxLength(universe.length),
            ),
          }),
        ),
      }),
    ),
    excludedSymbols: symbols,
    targets: Schema.NullOr(coreTargets),
  }),
  plan: Schema.Struct({
    ...commonPlan,
    reviewDue: Bool,
    collarBps: Count,
    deadbandBps: Count,
    reservedGrossCents: Count,
  }),
})
export type CoreReceipt = typeof CoreReceipt.Type

enum MacroQuadrant {
  Goldilocks = 'Goldilocks',
  Reflation = 'Reflation',
  Stagflation = 'Stagflation',
  Deflation = 'Deflation',
}
enum CanarySleeve {
  Canary = 'canary',
  Trend = 'tsmom',
  Macro = 'macro',
}
const canaryWeights = canaryVector(Weight)
export const CanaryReceipt = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.macro-canary-rebalance-receipt.v1'),
  ...common,
  strategyRevision: Schema.Literal(wave5dRevision),
  signalBars: Schema.Struct({
    ...signalBars,
    sessions: Schema.Literal(historyLength),
    firstSession: Date,
    macroSeedSessions: Count,
  }),
  signals: Schema.Struct({
    reviewedAt: Date,
    reviewDue: Bool,
    canaries: Schema.Array(Schema.Struct({ symbol: SymbolSchema, score: Finite, protective: Bool })),
    canaryProtection: Weight,
    tsmomScores: canaryVector(Finite),
    macro: Schema.Struct({
      quadrant: Schema.Enum(MacroQuadrant),
      credit: Finite,
      inflation: Finite,
      dollar: Finite,
      unsmoothedWeights: canaryWeights,
    }),
    sleeves: Schema.Array(
      Schema.Struct({ name: Schema.Enum(CanarySleeve), riskBudget: Weight, weights: canaryWeights }),
    ),
    idleShyWeight: Weight,
    targetWeights: canaryTargets,
  }),
  plan: Schema.Struct({
    ...commonPlan,
    excludedSymbols: symbols,
    excludedTargetWeight: Weight,
    driftBand: Weight,
    collarBp: Count,
    sizing: Schema.Array(
      Schema.Struct({
        symbol: Schema.Literals(etfs),
        managed: Bool,
        referenceMicros: PositiveFiniteSchema,
        currentWeight: Schema.NullOr(Finite),
        targetWeight: Weight,
        outsideBand: Bool,
      }),
    ).check(
      Schema.makeFilter((rows) => rows.length === etfs.length && uniqueSymbols(rows), {
        expected: 'complete unique macro canary sizing',
      }),
    ),
    otherGrossCents: Count,
    usedBuyScale: Weight,
    sellLimitNotionalCents: Count,
    referenceNotionalMicros: Count,
    expectedTurnover: Finite,
    expectedSleeveTurnover: Schema.NullOr(Finite),
  }),
})
export type CanaryReceipt = typeof CanaryReceipt.Type

// Standalone wire contract of the read-only SIP verifier (#16399). No runtime import from the shadow lane.
const Summary = Schema.Struct({ count: Count, median: bps, p75: bps, p95: bps })
const FeedReport = Schema.Struct({
  expectedBars: Count,
  barCount: Count,
  barCoverage: Weight,
  quoteCount: Count,
  spreadBps: Summary,
  crossedQuotes: Count,
  lockedQuotes: Count,
  oneSidedQuotes: Count,
  staleQuotes: Count,
  staleQuoteRate: Schema.NullOr(Weight),
  barIngestLatencyMs: Summary,
  quoteIngestLatencyMs: Summary,
})
const feedReports = { iex: FeedReport, sip: FeedReport, barCloseDivergenceBps: Summary }
export const SipReceipt = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.sip-shadow-parity-report.v1'),
  session: SessionCalendar,
  expectedMinutes: Count,
  universe: Schema.Struct({
    id: Id,
    expectedHash: Sha256Schema,
    observedHash: Sha256Schema,
    observedCount: Count,
    missing: Schema.Array(SignalRowSymbolSchema),
    unexpected: Schema.Array(SignalRowSymbolSchema),
    mismatchedSipRows: Count,
  }),
  gate: Schema.Struct({
    pass: Bool,
    checks: Schema.Array(
      Schema.Struct({ id: Id, pass: Bool, criterion: Id, actual: Schema.NullOr(Schema.Union([Id, Finite])) }),
    ),
  }),
  pooled: Schema.Struct(feedReports),
  commonSymbolSpreads: Schema.Struct({ symbols, iex: Summary, sip: Summary, medianSpreadCompressionBps: bps }),
  bySymbol: Schema.Array(Schema.Struct({ symbol: SymbolSchema, ...feedReports, medianSpreadCompressionBps: bps })),
})
export type SipReceipt = typeof SipReceipt.Type

export const QualificationFile = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.multi-horizon-qualification-evidence.v1'),
  paperAccountSha256: Sha256Schema,
  policy: Schema.Literal('bayn.intraday-alpha-policy.v3'),
  protocolSha256: Sha256Schema,
  calendarSourceSha256: Sha256Schema,
  riskCostPolicySha256: Sha256Schema,
  calendar: Schema.Array(SessionCalendar).check(Schema.isMinLength(1)),
  proofs: Schema.Array(
    Schema.Struct({
      date: Date,
      auditSessionSha256: Sha256Schema,
      sourceSha256: Sha256Schema,
      intradayPeakGrossMicros: UnsignedMicros,
      riskCostMicros: UnsignedMicros,
      stopEvidenceComplete: Bool,
    }),
  ),
})
