import { Result, Schema } from 'effect'
import { OrderStatus } from '../broker/alpaca/model'
import { canonicalHashV1Result } from '../hash'
import { createReplayLedger, applyReplayFill, type EconomicReplayFill } from '../intraday-replay/ledger'
import { numberToMicros } from '../strategy/execution-model/fixed-point'
import {
  NonNegativeIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
} from '../schemas'
import { ReconciliationStatus } from '../execution/contracts'
import { SystemAssessmentError } from './economics'
import { FrozenControlBacktestSchema, prepareFrozenControlReplay } from './frozen-control-replay'
import { ReplaySessionCostsSchema, reproduceSessionEconomics } from './latency-economics'
import { JevResearchPolicy } from '../jev/acceptance'

export const frozenQuantityAtoms = (quantityMicros: bigint) => quantityMicros * 1000n

const Fill = Schema.Struct({
  brokerOrderId: Schema.String,
  clientOrderId: Schema.String,
  symbol: Schema.String,
  side: Schema.Literals(['buy', 'sell']),
  observedAt: UtcInstantSchema,
  quantityMicros: PositiveMicrosSchema,
  priceMicros: PositiveMicrosSchema,
  notionalMicros: PositiveMicrosSchema,
  quoteSource: Schema.Struct({
    topic: Schema.String,
    partition: NonNegativeIntegerSchema,
    offset: UnsignedMicrosSchema,
    availableAtMs: NonNegativeIntegerSchema,
  }),
})
const Order = Schema.Struct({
  brokerOrderId: Schema.String,
  clientOrderId: Schema.String,
  accountId: Schema.String,
  symbol: Schema.String,
  side: Schema.Literals(['buy', 'sell']),
  status: Schema.Enum(OrderStatus),
  quantityMicros: PositiveMicrosSchema,
  filledQuantityMicros: UnsignedMicrosSchema,
  limitPriceMicros: PositiveMicrosSchema,
  submittedAt: UtcInstantSchema,
  updatedAt: UtcInstantSchema,
  orderClass: Schema.Literal('simple'),
  orderType: Schema.Literal('limit'),
  timeInForce: Schema.Literal('ioc'),
  extendedHours: Schema.Literal(false),
})
const Ledger = Schema.Struct({
  openingCashMicros: PositiveMicrosSchema,
  cashMicros: UnsignedMicrosSchema,
  executionFeesMicros: UnsignedMicrosSchema,
  netRealizedPnlAfterCostsMicros: Schema.NullOr(SignedMicrosSchema),
  positions: Schema.Array(
    Schema.Struct({
      symbol: Schema.String,
      quantityMicros: PositiveMicrosSchema,
      costBasisMicros: UnsignedMicrosSchema,
    }),
  ),
  fills: Schema.Array(Fill),
})
const Activity = Schema.Struct({
  activityId: Schema.String,
  brokerOrderId: Schema.String,
  accountId: Schema.String,
  symbol: Schema.String,
  side: Schema.Literals(['buy', 'sell']),
  transactionTime: UtcInstantSchema,
  quantityMicros: PositiveMicrosSchema,
  priceMicros: PositiveMicrosSchema,
  cumulativeQuantityMicros: PositiveMicrosSchema,
  leavesQuantityMicros: UnsignedMicrosSchema,
})
const Broker = Schema.Struct({
  runId: Sha256Schema,
  accountId: Schema.String,
  ledger: Ledger,
  orders: Schema.Array(Schema.Struct({ order: Order, execution: Schema.Unknown })),
  fills: Schema.Array(Activity),
  fees: Schema.Array(
    Schema.Struct({
      activityId: Schema.String,
      accountId: Schema.String,
      date: Schema.String,
      netAmountMicros: SignedMicrosSchema,
    }),
  ),
  sessionCloses: Schema.Array(Schema.Struct({ sessionDate: Schema.String, equityMicros: SignedMicrosSchema })),
})
const Release = Schema.Struct({
  kind: Schema.Literals(['DECISION', 'CLOSE']),
  decisionHash: Sha256Schema,
  decisionAt: UtcInstantSchema,
  commandIssuedAt: UtcInstantSchema,
  completedAt: UtcInstantSchema,
  releaseFloorAt: UtcInstantSchema,
  releasedAt: UtcInstantSchema,
})
const Document = Schema.Struct({
  contentHash: Sha256Schema,
  createdAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  orderedIntentIds: Schema.Array(Sha256Schema),
})
const Receipt = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.frozen-control-latency-report.v1'),
  runId: Sha256Schema,
  engineRunId: Sha256Schema,
  reportHash: Sha256Schema,
  executableSha256: Sha256Schema,
  evidenceMode: Schema.Literal('simulated-production-execution'),
  completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
  sourceReceiptHash: Sha256Schema,
  assumptions: FrozenControlBacktestSchema.fields.assumptions,
  source: Schema.Struct({
    runId: Sha256Schema,
    sourceManifestHash: Sha256Schema,
    featureTopic: Schema.String,
    deliveryModel: Schema.Unknown,
  }),
  frozenRequest: Schema.Unknown,
  frozenProtocol: Schema.Unknown,
  build: Schema.Struct({
    sourceRevision: Schema.String,
    imageRepository: Schema.String,
    strategyBehaviorHash: Sha256Schema,
    strategyParameterHash: Sha256Schema,
    declaredImageDigest: Schema.String,
    sourceAndStrategyVerification: Schema.Literals(['embedded', 'configured']),
  }),
  sessionDates: Schema.Array(Schema.String),
  frozenLatency: Schema.Struct({
    p95FullBatchMs: NonNegativeIntegerSchema,
    opening: Schema.Struct({ createdAt: UtcInstantSchema, state: Broker }),
    receipts: Schema.Array(Release),
  }),
  decisions: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  closingDecisions: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  brokerState: Broker,
  sessions: Schema.Array(
    Schema.Struct({
      sessionDate: Schema.String,
      completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
      issues: Schema.Array(Schema.String),
      valuationFailureCount: NonNegativeIntegerSchema,
      schedule: Schema.Struct({
        firstPollAtMs: NonNegativeIntegerSchema,
        lastPollAtMs: NonNegativeIntegerSchema,
        completedAtMs: NonNegativeIntegerSchema,
        passCount: NonNegativeIntegerSchema,
        failedPassCount: NonNegativeIntegerSchema,
        unavailableDecisionPassCount: NonNegativeIntegerSchema,
      }),
      closingEquity: Schema.Struct({ equityMicros: SignedMicrosSchema, sessionDate: Schema.String }),
      remainingPositions: Schema.Array(Schema.Unknown),
      reconciliation: Schema.Struct({
        report: Schema.Struct({
          reconciliation: Schema.Struct({ status: Schema.Enum(ReconciliationStatus) }),
          metrics: Schema.Struct({
            accountingExact: Schema.Boolean,
            discrepancyCount: NonNegativeIntegerSchema,
            cashDifferenceMicros: SignedMicrosSchema,
            positionDifferenceMicros: SignedMicrosSchema,
            equityDifferenceMicros: SignedMicrosSchema,
            oldestUnknownMutationAgeMs: NonNegativeIntegerSchema,
          }),
        }),
        brokerState: Schema.Struct({ unknownOrderCount: NonNegativeIntegerSchema }),
        riskContext: Schema.Struct({ unknownMutationCount: NonNegativeIntegerSchema }),
      }),
    }),
  ),
  accountingEvidence: Schema.Struct({
    encoding: Schema.Literal('postgres-json-text-preserving-numeric-precision'),
    transactions: Schema.Array(Schema.String),
    receipts: Schema.Array(Schema.String),
    fees: Schema.Array(Schema.String),
  }),
})
export const FrozenControlReportSchema = Receipt

// PostgreSQL renders numeric columns as JSON number tokens. Preserve them before Schema or BigInt sees them.
export const decodeFrozenAccountingRow = (text: string) =>
  Result.try({
    try: () =>
      JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
        if (typeof value !== 'number') return value
        if (context?.source === undefined || !/^[-]?(?:0|[1-9][0-9]*)$/.test(context.source))
          throw Error('Accounting number lacks its exact integer source token')
        return context.source
      }) as unknown,
    catch: (cause) => new SystemAssessmentError({ message: 'Cannot decode exact original accounting evidence', cause }),
  })
const SqlInstant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
)
const Transaction = Schema.Struct({
  transaction_id: Sha256Schema,
  broker_event_id: Sha256Schema,
  intent_id: Sha256Schema,
  account_id: Schema.String,
  symbol: Schema.String,
  side: Schema.Literals(['BUY', 'SELL']),
  quantity_micros: PositiveMicrosSchema,
  price_micros: PositiveMicrosSchema,
  notional_micros: PositiveMicrosSchema,
  fee_micros: UnsignedMicrosSchema,
  cash_delta_micros: SignedMicrosSchema,
  realized_pnl_micros: SignedMicrosSchema,
  occurred_at: SqlInstant,
})
const Posting = Schema.Struct({
  broker_event_id: Sha256Schema,
  intent_id: Sha256Schema,
  debit_micros: UnsignedMicrosSchema,
  credit_micros: UnsignedMicrosSchema,
  account_ids: Schema.Array(PositiveMicrosSchema),
  transfer_ids: Schema.Array(PositiveMicrosSchema),
  recorded_at: SqlInstant,
})
const Fee = Schema.Struct({
  account_id: Schema.String,
  activity_id: Schema.String,
  net_amount_micros: SignedMicrosSchema,
  posted_at: Schema.NullOr(SqlInstant),
})

/** Independently reproduce the original policy's releases, execution terms, PostgreSQL cash and fill ledger. */
export const reproduceFrozenControlReport = (
  prepared: Result.Result.Success<ReturnType<typeof prepareFrozenControlReplay>>,
  raw: unknown,
  rawCosts: unknown,
  verifiedSources: ReadonlySet<string>,
) =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    const same = (a: unknown, b: unknown) =>
      Result.gen(function* () {
        return (yield* canonicalHashV1Result(a)) === (yield* canonicalHashV1Result(b))
      })
    const object = yield* Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))(raw)
    const { reportHash, ...material } = object
    if (reportHash !== (yield* canonicalHashV1Result(material)))
      return yield* fail('Frozen report hash differs from its complete original evidence')
    const report = yield* Schema.decodeUnknownResult(Receipt)(object)
    const { input, engineRunId, runId, stress, definition } = prepared
    const registration = stress.registration
    const costs = yield* Schema.decodeUnknownResult(ReplaySessionCostsSchema)(rawCosts)
    const opening = report.frozenLatency.opening
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    if (
      first === undefined ||
      last === undefined ||
      report.runId !== runId ||
      report.engineRunId !== engineRunId ||
      report.brokerState.runId !== engineRunId ||
      report.sourceReceiptHash !== prepared.captureHash ||
      !(yield* same(report.assumptions, input.backtest.assumptions)) ||
      report.source.runId !== engineRunId ||
      report.source.sourceManifestHash !== (yield* canonicalHashV1Result(input.backtest.source)) ||
      report.source.featureTopic !== input.backtest.source.universe.topics.features ||
      !(yield* same(report.source.deliveryModel, input.backtest.source.deliveryModel)) ||
      !(yield* same(report.frozenRequest, input)) ||
      !(yield* same(report.frozenProtocol, input.protocol)) ||
      report.frozenLatency.p95FullBatchMs !== stress.p95FullBatchMs ||
      report.build.sourceRevision !== definition.sourceRevision ||
      report.build.imageRepository !== input.backtest.build.imageRepository ||
      report.build.declaredImageDigest !== `sha256:${definition.imageDigest}` ||
      report.build.strategyBehaviorHash !== definition.strategyHash ||
      report.build.strategyParameterHash !== definition.parametersHash ||
      costs.policy !== JevResearchPolicy.Deployed ||
      costs.inferenceCalls.length !== 0 ||
      costs.asOf > input.latencyStress.sourceCut.asOf ||
      opening.createdAt > first.openAt ||
      opening.state.runId !== engineRunId ||
      opening.state.accountId !== report.brokerState.accountId ||
      opening.state.accountId !== `replay-${engineRunId}` ||
      opening.state.orders.length !== 0 ||
      opening.state.fills.length !== 0 ||
      opening.state.fees.length !== 0 ||
      opening.state.sessionCloses.length !== 0 ||
      !(yield* same(report.sessionDates, input.backtest.sessionDates)) ||
      report.sessions.length !== 20 ||
      report.brokerState.sessionCloses.length !== 20
    )
      return yield* fail(
        'Frozen control evidence changed its registered input, opening state, costs or full session coverage',
      )
    const empty = yield* createReplayLedger(input.backtest.openingCashMicros)
    if (!(yield* same(opening.state.ledger, { ...empty, positions: [], fills: [] })))
      return yield* fail('Frozen control does not start with its registered unencumbered cash')
    const releases = new Map(report.frozenLatency.receipts.map((value) => [value.decisionHash, value]))
    const documents = new Map<string, { document: typeof Document.Type; release: typeof Release.Type }>()
    if (releases.size !== report.frozenLatency.receipts.length)
      return yield* fail('Frozen release duplicates a committed decision')
    for (const [kind, rawDocuments] of [
      ['DECISION', report.decisions],
      ['CLOSE', report.closingDecisions],
    ] as const) {
      for (const rawDocument of rawDocuments) {
        const sealed = yield* Schema.decodeUnknownResult(
          Schema.Struct({ contentHash: Sha256Schema, createdAt: UtcInstantSchema }),
        )(rawDocument)
        const { contentHash, ...body } = rawDocument
        if (contentHash !== (yield* canonicalHashV1Result(body)))
          return yield* fail('Frozen committed document hash does not reproduce')
        const rawBody = yield* Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))(
          kind === 'DECISION' ? rawDocument : rawDocument['document'],
        )
        const { contentHash: bodyHash, ...bodyMaterial } = rawBody
        if (bodyHash !== (yield* canonicalHashV1Result(bodyMaterial)))
          return yield* fail('Frozen execution document hash does not reproduce')
        const document = yield* Schema.decodeUnknownResult(Document)(rawBody)
        const release = releases.get(sealed.contentHash)
        const issued = Date.parse(release?.commandIssuedAt ?? '')
        if (
          release === undefined ||
          release.kind !== kind ||
          release.decisionAt !== sealed.createdAt ||
          release.commandIssuedAt > sealed.createdAt ||
          sealed.createdAt > release.completedAt ||
          Date.parse(release.releaseFloorAt) !== issued + stress.p95FullBatchMs ||
          Date.parse(release.releasedAt) !==
            Math.max(Date.parse(release.completedAt), issued + stress.p95FullBatchMs) ||
          !registration.calendar.sessions.some(
            (session) => session.openAt <= release.commandIssuedAt && release.commandIssuedAt <= session.closeAt,
          ) ||
          documents.has(sealed.contentHash)
        )
          return yield* fail(
            'Frozen release does not preserve its original command, durable decision or actual completion',
          )
        documents.set(sealed.contentHash, { document, release })
      }
    }
    if (documents.size !== releases.size)
      return yield* fail('Frozen release inventory omits or invents a committed decision')
    const orders = new Map(report.brokerState.orders.map((row) => [row.order.brokerOrderId, row]))
    const liquidity = new Map<string, { capacity: bigint; used: bigint }>()
    if (
      orders.size !== report.brokerState.orders.length ||
      new Set([...orders.values()].map((row) => row.order.clientOrderId)).size !== orders.size
    )
      return yield* fail('Frozen orders duplicate an economic identity')
    if (
      report.brokerState.fills.length !== report.brokerState.ledger.fills.length ||
      new Set(report.brokerState.fills.map((fill) => fill.activityId)).size !== report.brokerState.fills.length
    )
      return yield* fail('Frozen broker activities omit or duplicate actual fills')
    for (const { order, execution } of orders.values()) {
      const instrument = input.executionInstruments[order.symbol]
      const quantity = frozenQuantityAtoms(BigInt(order.quantityMicros))
      const priceAtoms = BigInt(order.limitPriceMicros) * 1000n
      // The old model's declared precision may be finer; its actual terms must still obey the registered instrument.
      if (
        instrument === undefined ||
        order.accountId !== report.brokerState.accountId ||
        quantity % BigInt(instrument.quantityIncrementAtoms) !== 0n ||
        priceAtoms % BigInt(instrument.priceIncrementAtoms) !== 0n ||
        (order.side === 'buy' && quantity < BigInt(instrument.minimumQuantityAtoms)) ||
        ![...documents.values()].some(
          ({ document, release }) =>
            document.orderedIntentIds.some(
              (id) => `b1_${Buffer.from(id, 'hex').toString('base64url')}` === order.clientOrderId,
            ) &&
            release.releasedAt <= order.submittedAt &&
            order.submittedAt < document.expiresAt &&
            order.submittedAt < document.submissionCutoffAt,
        )
      )
        return yield* fail('Frozen order violates registered precision, ownership or its committed decision release')
      const arrival = yield* Schema.decodeUnknownResult(
        Schema.Struct({
          submittedAt: UtcInstantSchema,
          arrivedAt: UtcInstantSchema,
          quote: Schema.optionalKey(
            Schema.Struct({
              symbol: Schema.String,
              askPrice: Schema.Finite,
              bidPrice: Schema.Finite,
              askSize: Schema.Finite,
              bidSize: Schema.Finite,
              availableAtMs: NonNegativeIntegerSchema,
              sourceTopic: Schema.String,
              sourcePartition: NonNegativeIntegerSchema,
              sourceOffset: UnsignedMicrosSchema,
            }),
          ),
          outcome: Schema.Struct({ status: Schema.String }),
        }),
      )(execution)
      if (
        arrival.submittedAt !== order.submittedAt ||
        arrival.arrivedAt < order.submittedAt ||
        Date.parse(arrival.arrivedAt) > Date.parse(order.submittedAt) + input.backtest.assumptions.latencyMs
      )
        return yield* fail('Frozen broker arrival changed the registered routing latency')
      const fills = report.brokerState.ledger.fills.filter((fill) => fill.brokerOrderId === order.brokerOrderId)
      if (
        fills.length > 1 ||
        fills.reduce((total, fill) => total + BigInt(fill.quantityMicros), 0n) !== BigInt(order.filledQuantityMicros)
      )
        return yield* fail('Frozen fills exceed or disagree with their retained order')
      for (const fill of fills) {
        const activity = report.brokerState.fills.find((value) => value.brokerOrderId === fill.brokerOrderId)
        if (
          activity === undefined ||
          activity.accountId !== report.brokerState.accountId ||
          activity.symbol !== fill.symbol ||
          activity.side !== fill.side ||
          activity.transactionTime !== fill.observedAt ||
          activity.quantityMicros !== fill.quantityMicros ||
          activity.priceMicros !== fill.priceMicros ||
          activity.cumulativeQuantityMicros !== order.filledQuantityMicros ||
          BigInt(activity.leavesQuantityMicros) !== BigInt(order.quantityMicros) - BigInt(order.filledQuantityMicros)
        )
          return yield* fail('Frozen fill ledger differs from its actual broker activity')
        const quote = arrival.quote
        if (quote === undefined) return yield* fail('Frozen fill lacks its original arrival quote')
        const top = yield* numberToMicros(order.side === 'buy' ? quote.askPrice : quote.bidPrice)
        const size = yield* numberToMicros(order.side === 'buy' ? quote.askSize : quote.bidSize)
        const capacity =
          ((size * BigInt(input.backtest.assumptions.availableLiquidityPpm)) / 1000000n / 1000000n) * 1000000n
        const quoteKey = `${quote.sourceTopic}:${quote.sourcePartition}:${quote.sourceOffset}:${order.side}`
        const consumed = liquidity.get(quoteKey) ?? { capacity, used: 0n }
        if (consumed.capacity !== capacity || consumed.used + BigInt(fill.quantityMicros) > capacity)
          return yield* fail('Frozen orders reuse unsupported liquidity from the same source quote')
        liquidity.set(quoteKey, { capacity, used: consumed.used + BigInt(fill.quantityMicros) })
        const price = BigInt(fill.priceMicros)
        const bps = BigInt(input.backtest.assumptions.slippageBps)
        const adverse = top * (order.side === 'buy' ? 10000n + bps : 10000n - bps)
        const expectedPrice =
          order.side === 'buy' ? ((adverse + 1000000n - 1n) / 1000000n) * 100n : (adverse / 1000000n) * 100n
        if (
          fill.symbol !== order.symbol ||
          fill.side !== order.side ||
          fill.clientOrderId !== order.clientOrderId ||
          fill.observedAt !== arrival.arrivedAt ||
          fill.quoteSource.availableAtMs !== quote.availableAtMs ||
          quote.availableAtMs > Date.parse(arrival.arrivedAt) ||
          quote.symbol !== order.symbol ||
          fill.quoteSource.topic !== quote.sourceTopic ||
          fill.quoteSource.partition !== quote.sourcePartition ||
          fill.quoteSource.offset !== quote.sourceOffset ||
          BigInt(fill.quantityMicros) > BigInt(order.quantityMicros) ||
          BigInt(fill.quantityMicros) > capacity ||
          frozenQuantityAtoms(BigInt(fill.quantityMicros)) % BigInt(instrument.quantityIncrementAtoms) !== 0n ||
          price !== expectedPrice ||
          (price * 1000n) % BigInt(instrument.priceIncrementAtoms) !== 0n ||
          (order.side === 'buy'
            ? price < top || price > BigInt(order.limitPriceMicros)
            : price > top || price < BigInt(order.limitPriceMicros))
        )
          return yield* fail('Frozen fill invents liquidity, price improvement or execution before source availability')
      }
    }
    if (report.brokerState.ledger.fills.some((fill) => !orders.has(fill.brokerOrderId)))
      return yield* fail('Frozen ledger contains an orderless fill')
    const transactions = []
    for (const text of report.accountingEvidence.transactions)
      transactions.push(yield* Schema.decodeUnknownResult(Transaction)(yield* decodeFrozenAccountingRow(text)))
    const postings = []
    for (const text of report.accountingEvidence.receipts)
      postings.push(yield* Schema.decodeUnknownResult(Posting)(yield* decodeFrozenAccountingRow(text)))
    const fees = []
    for (const text of report.accountingEvidence.fees)
      fees.push(yield* Schema.decodeUnknownResult(Fee)(yield* decodeFrozenAccountingRow(text)))
    if (
      transactions.length !== report.brokerState.ledger.fills.length ||
      postings.length !== transactions.length ||
      new Set(transactions.map((row) => row.broker_event_id)).size !== transactions.length ||
      new Set(transactions.map((row) => row.transaction_id)).size !== transactions.length ||
      new Set(postings.map((row) => row.broker_event_id)).size !== postings.length ||
      new Set(fees.map((row) => row.activity_id)).size !== fees.length ||
      fees.length !== report.brokerState.fees.length
    )
      return yield* fail('Frozen accounting omits or duplicates fills, ledger receipts or broker charges')
    const usedTransactions = new Set<string>()
    for (const fill of report.brokerState.ledger.fills) {
      const matches = transactions.filter(
        (row) =>
          row.account_id === report.brokerState.accountId &&
          row.symbol === fill.symbol &&
          row.side === fill.side.toUpperCase() &&
          row.quantity_micros === fill.quantityMicros &&
          row.price_micros === fill.priceMicros &&
          row.notional_micros === fill.notionalMicros &&
          new Date(row.occurred_at).toISOString() === fill.observedAt &&
          `b1_${Buffer.from(row.intent_id, 'hex').toString('base64url')}` === fill.clientOrderId,
      )
      const transaction = matches[0]
      const posting =
        transaction === undefined
          ? undefined
          : postings.find((row) => row.broker_event_id === transaction.broker_event_id)
      if (
        matches.length !== 1 ||
        transaction === undefined ||
        usedTransactions.has(transaction.transaction_id) ||
        posting === undefined ||
        posting.intent_id !== transaction.intent_id ||
        posting.debit_micros !== posting.credit_micros ||
        posting.transfer_ids.length === 0 ||
        posting.account_ids.length === 0 ||
        new Date(posting.recorded_at).toISOString() > input.latencyStress.sourceCut.asOf ||
        transaction.cash_delta_micros !==
          (fill.side === 'buy'
            ? -(BigInt(fill.notionalMicros) + BigInt(transaction.fee_micros))
            : BigInt(fill.notionalMicros) - BigInt(transaction.fee_micros)
          ).toString()
      )
        return yield* fail('Frozen PostgreSQL fill or TigerBeetle posting does not reproduce the broker execution')
      usedTransactions.add(transaction.transaction_id)
    }
    let totalFees = 0n
    for (const fee of report.brokerState.fees) {
      const matched = fees.find((row) => row.activity_id === fee.activityId)
      if (
        matched === undefined ||
        matched.account_id !== fee.accountId ||
        fee.accountId !== report.brokerState.accountId ||
        matched.net_amount_micros !== fee.netAmountMicros ||
        matched.posted_at === null ||
        new Date(matched.posted_at).toISOString() > input.latencyStress.sourceCut.asOf
      )
        return yield* fail('Frozen broker charge lacks its unique posted accounting evidence')
      totalFees -= BigInt(fee.netAmountMicros)
    }
    const sqlCash =
      BigInt(input.backtest.openingCashMicros) +
      transactions.reduce((sum, row) => sum + BigInt(row.cash_delta_micros), 0n) -
      totalFees
    if (
      sqlCash.toString() !== report.brokerState.ledger.cashMicros ||
      totalFees.toString() !== report.brokerState.ledger.executionFeesMicros ||
      (report.brokerState.ledger.netRealizedPnlAfterCostsMicros !== null &&
        (transactions.reduce((sum, row) => sum + BigInt(row.realized_pnl_micros), 0n) - totalFees).toString() !==
          report.brokerState.ledger.netRealizedPnlAfterCostsMicros)
    )
      return yield* fail('Frozen cash and charges do not independently reconcile the fill ledger')
    let ledger = yield* createReplayLedger<EconomicReplayFill>(input.backtest.openingCashMicros)
    for (const fill of report.brokerState.ledger.fills) {
      const converted = { ...fill, quantityAtoms: frozenQuantityAtoms(BigInt(fill.quantityMicros)).toString() }
      ledger = yield* applyReplayFill(
        ledger,
        converted,
        converted.quantityAtoms,
        prepared.protocol.executionModel,
        input.backtest.assumptions.feeMultiplierPpm,
      )
    }
    if (
      !(yield* same(
        ledger.positions,
        report.brokerState.ledger.positions.map(({ quantityMicros, ...position }) => ({
          ...position,
          quantityAtoms: frozenQuantityAtoms(BigInt(quantityMicros)).toString(),
        })),
      )) ||
      ledger.cashMicros !== report.brokerState.ledger.cashMicros ||
      ledger.executionFeesMicros !== report.brokerState.ledger.executionFeesMicros ||
      ledger.netRealizedPnlAfterCostsMicros !== report.brokerState.ledger.netRealizedPnlAfterCostsMicros
    )
      return yield* fail('Frozen fills do not reproduce its complete cash, fees and flat inventory')
    let complete = report.completion === 'COMPLETE' && (report.issues?.length ?? 0) === 0
    for (const [index, window] of registration.calendar.sessions.entries()) {
      const session = report.sessions[index],
        close = report.brokerState.sessionCloses[index]
      if (
        session === undefined ||
        close === undefined ||
        session.sessionDate !== window.sessionDate ||
        close.sessionDate !== window.sessionDate ||
        session.closingEquity.sessionDate !== window.sessionDate ||
        session.closingEquity.equityMicros !== close.equityMicros ||
        session.schedule.firstPollAtMs < Date.parse(window.openAt) ||
        session.schedule.lastPollAtMs !== Date.parse(window.closeAt) ||
        session.schedule.completedAtMs < session.schedule.lastPollAtMs
      )
        return yield* fail('Frozen session evidence substitutes its registered window or closing valuation')
      const metrics = session.reconciliation.report.metrics
      const valid =
        session.completion === 'COMPLETE' &&
        session.issues.length === 0 &&
        session.schedule.passCount > 0 &&
        session.schedule.failedPassCount === 0 &&
        session.schedule.unavailableDecisionPassCount === 0 &&
        session.valuationFailureCount === 0 &&
        session.remainingPositions.length === 0 &&
        session.reconciliation.report.reconciliation.status === ReconciliationStatus.Exact &&
        metrics.accountingExact &&
        metrics.discrepancyCount === 0 &&
        metrics.cashDifferenceMicros === '0' &&
        metrics.positionDifferenceMicros === '0' &&
        metrics.equityDifferenceMicros === '0' &&
        metrics.oldestUnknownMutationAgeMs === 0 &&
        session.reconciliation.brokerState.unknownOrderCount === 0 &&
        session.reconciliation.riskContext.unknownMutationCount === 0
      complete &&= valid
    }
    const checkpoint = {
      checkpointHash: report.reportHash,
      observedAt: new Date(Math.max(...report.sessions.map((session) => session.schedule.completedAtMs))).toISOString(),
      state: {
        createdAt: opening.createdAt,
        ledger,
        orders: report.brokerState.orders,
        sessionCloses: report.brokerState.sessionCloses.map((close) => ({ ...close, valuationQualified: complete })),
      },
    }
    const economics = complete
      ? yield* reproduceSessionEconomics(
          registration,
          {
            openingCashMicros: input.backtest.openingCashMicros,
            feeModel: prepared.protocol.executionModel,
            feeMultiplierPpm: input.backtest.assumptions.feeMultiplierPpm,
          },
          checkpoint,
          costs,
          verifiedSources,
        )
      : null
    return { report, economics }
  })
