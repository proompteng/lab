import { controlExitDefinition } from './control-portfolio'
import { equityMarketProfile } from '../jev/markets'
import { MarketKind } from '../instruments'
import { makeJevEntryQuery } from '../jev/observation-query'
import { intradayMinimumCompletedHistoryMs } from '../strategy/intraday-market'
import { Clock, Effect, FileSystem, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import {
  RidgeTrainingOutcome,
  type RidgeTrainingAttempt,
  type RidgeTrainingSelection,
} from './ridge-training-selection'

import { AssetStatus, type MarketCalendarObservation, type MarketCalendarSession } from '../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { OrderSide } from '../execution/contracts'
import { EntryTurnoverPolicy } from '../execution/turnover-reserve'
import { numberToMicros } from '../strategy/execution-model/fixed-point'
import { canonicalHashV1Result } from '../hash'
import type { JevProtocol } from '../jev/protocol'
import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import { observedQuoteAt } from '../market-data/streaming/projection'
import {
  constructSimulatedSnapshot,
  type StrategyMarketSnapshot,
  type VerifiedStrategyMarketSnapshot,
} from '../market-data/streaming/snapshot'
import { loadExecutionRiskPolicy } from '../observe-composition/decision-builder'
import type { Policy } from '../risk'
import { IsoDateSchema, NonNegativeIntegerSchema, PositiveIntegerSchema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import { BacktestInputSchema, prepareBacktest } from './backtest'
import { replayQuoteRejection } from './broker-execution-evidence'
import { makeControlJev, type ControlJevBinding } from './control-jev'
import { makeControlJevJournal } from './control-jev-journal'
import { calculateReplayJevCosts, type ReplayJevCostModelSchema } from './jev-costs'
import {
  applyControlOrder,
  controlCandidates,
  controlEntryQuantity,
  ControlPolicy,
  ControlStudyFailure,
  createControlPortfolio,
  selectControlSymbol,
  triggerControlExit,
  type ControlQuote,
} from './control-portfolio'
import { openBacktestSource, type BacktestSourceReceipt } from './source'
import { residualShockDefinition, selectResidualShock } from './residual-shock'
import {
  BoundRidgeInputSchema,
  prepareBoundRidge,
  ridgeExecutionLabelDefinition,
  selectBoundRidge,
  type BoundRidge,
} from './control-ridge'

export enum ControlManagementMode {
  Mechanical = 'MECHANICAL',
}

export enum ControlEntryMode {
  Deterministic = 'DETERMINISTIC',
  Jev = 'JEV',
}

export type ControlStudyManagement =
  | { readonly mode: ControlManagementMode.Mechanical }
  | {
      readonly mode: ControlManagementMode
      readonly evidenceDirectory: string
      readonly provider: ControlJevBinding['provider']
      readonly providerClock: Clock.Clock
    }

export const ControlStudyInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.control-study-input.v9'),
  costObjective: Schema.Literals(['ALL_COSTS', 'KNOWN_COST_DIAGNOSTIC']),
  entry: Schema.Enum(ControlEntryMode),
  management: Schema.Enum(ControlManagementMode),
  backtest: BacktestInputSchema,
  decisionLatencyMs: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(60_000)),
  repeatedTargetWeightPpm: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(200_000)),
  turnoverPolicy: Schema.Enum(EntryTurnoverPolicy),
  falsificationCandidate: Schema.optionalKey(Schema.NullOr(Schema.Literal(residualShockDefinition.id))),
  ridge: Schema.optionalKey(BoundRidgeInputSchema),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.ridge !== undefined && input.falsificationCandidate != null) &&
      (input.ridge === undefined || input.management === ControlManagementMode.Mechanical) &&
      (input.entry !== ControlEntryMode.Jev ||
        (input.management === ControlManagementMode.Mechanical &&
          input.ridge === undefined &&
          input.falsificationCandidate == null)),
    { expected: 'one entry experiment, with mechanical management for the Jev entry comparison' },
  ),
)

export const controlStudyDefinition = {
  schemaVersion: 'bayn.control-study-definition.v12',
  policies: {
    RETAINED_BREAKOUT_CLOSE:
      'Six retained candidates, retained breakout thresholds, 10 percent allocation, hold until the close window.',
    REPEATED_BREAKOUT:
      'Jev candidate universe and retained breakout thresholds, mechanical stop, net-profit target and maximum hold, repeated entries.',
    REPEATED_RELATIVE_MOMENTUM:
      'Jev candidate universe, exact positive return and benchmark-relative return, mechanical stop, net-profit target and maximum hold, repeated entries.',
    REPEATED_JEV_ENTRY:
      'Native Jev entry selection from the independent flat portfolio, committed inference evidence before IOC pricing, mechanical management and repeated entries.',
  },
  opportunityClock:
    'Polls are anchored to session open. After decision and routing work, resume at the first scheduled poll at or after completion; never replay missed polls. Each flat portfolio evaluates the latest eligible completed signal window once successfully observed. Breakout policies use native momentum ranking including all tie-breaks. Relative momentum ranks by exact relative return, then symbol.',
  candidateEvidence:
    'Entry and management snapshots use the bound Jev candidate evidence policy. Relative momentum applies its quote/window-trade freshness contract. Breakout controls retain their independent native trade-confirmation freshness and breakout thresholds.',
  sizing:
    'Bayn target allocation and order/symbol/turnover bounds, whole shares, cash reserved for cumulative fees at the adverse buy limit.',
  turnover:
    'The input selects immediate adjustment or entry plus expected exit at the reference price and adverse allowance. The reserve is not a hard bound on future prices; mandatory reducing exits are unchanged.',
  execution:
    'Fresh decision and arrival quotes, shared native IOC execution and accounting. Each portfolio consumes displayed liquidity once per quote identity, symbol and side. One entry IOC; persistent risk-reducing exit retries on the next poll.',
  management:
    'All controls use their declared mechanical exit policy. Jev can select an entry; it cannot manage a held position.',
  valuation:
    'Retain session boundaries, one-minute marks, each poll, decision completion and before/after order outcomes. Broker equity and its carried peak govern risk. Net equity deducts cumulative external costs only for reported performance, drawdown and session loss, matching native replay. External costs never change broker cash, sizing or risk.',
  limitations: [
    'DEVELOPMENT_CONTROL_PORTFOLIOS. Not the frozen matched-control acceptance experiment or a prospective qualification.',
    'MECHANICAL uses native stop, net-profit target and holding/session deadlines. The retained close control never calls Jev. The residual-shock candidate retains its frozen 60-second horizon without a profit trigger. No model responses are synthesized.',
    'The retained selection and close lifecycle do not reproduce historical persistence, reconciliation, authority, retry and market-close fallback machinery.',
    'Deterministic entry latency is a declared scenario. Jev entry measures provider and simulation-journal work, not production PostgreSQL persistence or a full-controller p95. Timing still requires calibration for the frozen matched comparison. Routing latency is added separately.',
    'Quote size units and impact remain uncalibrated. Source completeness and a flat simulated close do not establish executable live capacity.',
    'Missing decision or valuation evidence remains explicit and makes a session incomplete. Candidate-local exclusions remain in the decision trace.',
  ],
} as const

const deterministicControlPolicies = [
  ControlPolicy.RetainedBreakout,
  ControlPolicy.RepeatedBreakout,
  ControlPolicy.RelativeMomentum,
] as const
export const residualShockControlStudyDefinition = {
  ...controlStudyDefinition,
  schemaVersion: 'bayn.control-study-definition.v6',
  falsificationCandidate: residualShockDefinition,
} as const

enum ControlPollDisposition {
  Warmup = 'WARMUP',
  Holding = 'HOLDING',
  Exiting = 'EXITING',
  EntryCutoff = 'ENTRY_CUTOFF',
  WindowAlreadyConsumed = 'WINDOW_ALREADY_CONSUMED',
  InputUnavailable = 'INPUT_UNAVAILABLE',
  SelectionUnavailable = 'SELECTION_UNAVAILABLE',
  NoSignal = 'NO_SIGNAL',
  Selected = 'SELECTED',
  SkippedWhileBusy = 'SKIPPED_WHILE_BUSY',
}

const opportunityAccountingDefinition = {
  schemaVersion: 'bayn.simulated-opportunity-accounting.v1',
  schedule: 'Session-open anchored polls before session close, including warmup and cutoff. Close is excluded.',
  coverage: 'Each scheduled ordinal is accounted exactly once. Busy ranges cover skipped polls without executing them.',
  disposition:
    'Use the post-management entry branch: exiting, holding, then flat warmup, cutoff, consumed window, or the observed entry result. Selected includes later expiry, pricing, risk and execution outcomes retained in decisions and orders.',
  exclusions:
    'Count available entry snapshots with candidate exclusions separately. These counts overlap dispositions.',
  runtimeEvidence: 'Simulated engine schedule only. Captured production controller starts and terminals are unknown.',
} as const

const ridgeControlStudyDefinition = {
  schemaVersion: 'bayn.control-study-definition.v8',
  policies: [ControlPolicy.Ridge, ControlPolicy.TrainingMean],
  qualification: 'UNQUALIFIED',
  controllerCoverage: 'UNKNOWN',
  featureWindow: 'First-completed-minute entry eligibility; six-bar controls require six actual completed bars.',
  comparison:
    'Independent portfolios with identical initial capital and rules. This is a policy comparison, not exposure-matched alpha.',
  baseline:
    'The artifact-v2 day-weighted training target mean is the best constant under the frozen training objective.',
  sizing:
    'Fixed principal budget, whole shares, cash including fees and native risk/turnover limits. Actual fills can be smaller.',
  coverage:
    'Candidate-local gaps are evidenced zero-allocation exclusions; required benchmark and global failures make both policies unavailable, even if a frozen score would choose cash.',
  exclusions:
    'Entry exclusion counters count available six-bar decisions and their excluded candidates. Each exclusion retains the actual input symbol, reason and evidence hash.',
  opportunityAccounting: opportunityAccountingDefinition,
  execution: controlStudyDefinition.execution,
  valuation: controlStudyDefinition.valuation,
  limitations: controlStudyDefinition.limitations,
} as const

export interface ControlMarket {
  readonly advanceTo: (atMs: number) => Effect.Effect<void, ControlStudyFailure>
  readonly quoteAt: (symbol: string, atMs: number) => Effect.Effect<ControlQuote, ControlStudyFailure>
  readonly snapshot: (
    query: IntradaySnapshotQuery,
  ) => Effect.Effect<
    | { readonly status: 'AVAILABLE'; readonly snapshot: VerifiedStrategyMarketSnapshot }
    | { readonly status: 'UNAVAILABLE'; readonly cause: unknown },
    ControlStudyFailure
  >
}

export interface ControlCapital {
  readonly cashMicros: string
  readonly peakBrokerEquityMicros: string
  readonly peakNetEquityMicros: string
  readonly accruedExternalCostMicros: string
}

export const failureDetails = (cause: unknown) =>
  Result.try({
    try: () => JSON.stringify(cause),
    catch: (error) => new ControlStudyFailure({ message: 'Cannot retain control failure details', cause: error }),
  }).pipe(
    Result.flatMap((value) =>
      value === undefined
        ? Result.fail(new ControlStudyFailure({ message: 'Control failure has no serializable details' }))
        : Result.succeed(value),
    ),
  )

export const runControlSession = (input: {
  readonly policy: ControlPolicy
  readonly ridge?: {
    readonly bound: BoundRidge
    readonly select: (
      query: IntradaySnapshotQuery,
    ) => Effect.Effect<Result.Result.Success<ReturnType<typeof selectBoundRidge>>, ControlStudyFailure>
  }
  readonly training?: {
    readonly candidateSymbol: string
    readonly allocationBudgetMicros: string
    readonly select: (query: IntradaySnapshotQuery) => Effect.Effect<RidgeTrainingSelection, ControlStudyFailure>
  }
  readonly protocol: JevProtocol
  readonly risk: Policy
  readonly session: MarketCalendarSession
  readonly calendar: MarketCalendarObservation
  readonly openingCapital: ControlCapital
  readonly dataCostMicros: string | null
  readonly targetWeight: number
  readonly turnoverPolicy?: EntryTurnoverPolicy
  readonly decisionLatencyMs: number
  readonly pollIntervalMs: number
  readonly assumptions: typeof BacktestInputSchema.Type.assumptions
  readonly eligibleSymbols: ReadonlySet<string>
  readonly market: ControlMarket
  readonly management: null | {
    readonly runId: string
    readonly binding: ControlJevBinding
    readonly costs: typeof ReplayJevCostModelSchema.Type
  }
  readonly entry?: {
    readonly runId: string
    readonly binding: ControlJevBinding
    readonly costs: typeof ReplayJevCostModelSchema.Type
  }
}) =>
  Effect.gen(function* () {
    const { market, protocol, risk, session, assumptions } = input
    const jevBinding = input.entry ?? input.management
    if (
      (input.policy === ControlPolicy.JevEntry) !== (input.entry !== undefined) ||
      (input.entry !== undefined &&
        (input.management !== null ||
          input.targetWeight !==
            Math.floor(Math.min(protocol.maximumGrossWeight, protocol.maximumSymbolWeight) * 1_000_000) / 1_000_000))
    )
      return yield* new ControlStudyFailure({
        message: 'Jev entry requires its own native binding, matched allocation and mechanical exits',
      })
    const ridgePolicy = input.policy === ControlPolicy.Ridge || input.policy === ControlPolicy.TrainingMean
    if (
      ridgePolicy !== (input.ridge !== undefined) ||
      (ridgePolicy && (input.management !== null || input.targetWeight !== 1))
    )
      return yield* new ControlStudyFailure({
        message: 'Ridge sessions require bound mechanical fixed-budget entry and opportunity accounting',
      })
    if (
      (input.policy === ControlPolicy.FixedCandidateTraining) !== (input.training !== undefined) ||
      (input.training !== undefined &&
        (input.ridge !== undefined ||
          input.management !== null ||
          input.targetWeight !== 1 ||
          !equityMarketProfile.candidateSymbols.some((symbol) => symbol === input.training?.candidateSymbol)))
    )
      return yield* new ControlStudyFailure({
        message: 'Training requires a fixed native candidate and mechanical fixed-budget execution',
      })
    const fixedPrincipalBudget =
      input.ridge?.bound.artifact.allocationBudgetMicros ?? input.training?.allocationBudgetMicros
    if (input.ridge !== undefined) {
      const labelHash = yield* Effect.fromResult(
        canonicalHashV1Result(
          ridgeExecutionLabelDefinition(
            {
              protocol,
              risk,
              pollIntervalMs: input.pollIntervalMs,
              decisionLatencyMs: input.decisionLatencyMs,
              turnoverPolicy: input.turnoverPolicy ?? EntryTurnoverPolicy.ImmediateAdjustment,
              assumptions,
            },
            input.ridge.bound.artifact.allocationBudgetMicros,
          ),
        ),
      )
      const declared = input.ridge.bound.artifact.evaluationSessions.find((entry) => entry.date === session.date)
      if (
        labelHash !== input.ridge.bound.artifact.provenance.labelDefinitionHash ||
        declared === undefined ||
        declared.partition !== input.ridge.bound.partition ||
        declared.openAt !== session.openAt ||
        declared.closeAt !== session.closeAt
      )
        return yield* new ControlStudyFailure({ message: 'Ridge session differs from its admitted execution contract' })
    }
    const sessionDate = yield* Schema.decodeUnknownEffect(IsoDateSchema)(session.date)
    const openMs = Date.parse(session.openAt)
    const closeMs = Date.parse(session.closeAt)
    const cutoffMs = closeMs - protocol.entryCutoffMinutesBeforeClose * 60_000
    const warmupMs = openMs + intradayMinimumCompletedHistoryMs + protocol.decisionDelaySeconds * 1000
    const opportunities = {
      schemaVersion: opportunityAccountingDefinition.schemaVersion,
      schedule: {
        openAt: session.openAt,
        closeAtExclusive: session.closeAt,
        pollIntervalMs: input.pollIntervalMs,
      },
      scheduledPollCount: Math.ceil((closeMs - openMs) / input.pollIntervalMs),
      accountedPollCount: 0,
      engineStartedPollCount: 0,
      dispositionCounts: {
        [ControlPollDisposition.Warmup]: 0,
        [ControlPollDisposition.Holding]: 0,
        [ControlPollDisposition.Exiting]: 0,
        [ControlPollDisposition.EntryCutoff]: 0,
        [ControlPollDisposition.WindowAlreadyConsumed]: 0,
        [ControlPollDisposition.InputUnavailable]: 0,
        [ControlPollDisposition.SelectionUnavailable]: 0,
        [ControlPollDisposition.NoSignal]: 0,
        [ControlPollDisposition.Selected]: 0,
        [ControlPollDisposition.SkippedWhileBusy]: 0,
      },
      entrySnapshotsWithCandidateExclusions: 0,
      excludedCandidateObservationCount: 0,
      capturedControllerStarts: null,
      capturedControllerTerminals: null,
    }
    const accountPollRange = (first: number, end: number, disposition: ControlPollDisposition) => {
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(end) ||
        first !== opportunities.accountedPollCount ||
        end < first ||
        end > opportunities.scheduledPollCount
      )
        return Result.fail(
          new ControlStudyFailure({
            message: 'Control opportunity ordinals are not contiguous',
            cause: { first, end, accounted: opportunities.accountedPollCount, total: opportunities.scheduledPollCount },
          }),
        )
      opportunities.dispositionCounts[disposition] += end - first
      opportunities.accountedPollCount = end
      return Result.succeed(undefined)
    }
    const openingCash = BigInt(input.openingCapital.cashMicros)
    const dataCost = BigInt(input.dataCostMicros ?? '0')
    const openingNetEquity = openingCash - BigInt(input.openingCapital.accruedExternalCostMicros)
    const accruedExternalCost = BigInt(input.openingCapital.accruedExternalCostMicros) + dataCost
    const firstCallIndex = jevBinding === null ? 0 : (yield* jevBinding.binding.journal.calls).length
    const modelCosts = (atMs: number) =>
      Effect.gen(function* () {
        if (jevBinding === null) return { knownCostMicros: '0', unresolvedCallCount: 0, callCount: 0 }
        const calls = (yield* jevBinding.binding.journal.calls)
          .slice(firstCallIndex)
          .filter(
            (call) =>
              Date.parse(call.simulatedStartedAt) +
                Date.parse(call.providerCompletedAt) -
                Date.parse(call.providerStartedAt) <=
              atMs,
          )
        return calculateReplayJevCosts(calls, jevBinding.costs)
      })
    let portfolio = yield* Effect.fromResult(createControlPortfolio(String(openingCash)))
    let peakBrokerEquity = BigInt(input.openingCapital.peakBrokerEquityMicros)
    let peakNetEquity = BigInt(input.openingCapital.peakNetEquityMicros)
    let maximumDrawdown = 0n
    let maximumSessionLoss = dataCost
    let lastWindow = -1
    let lastEntryDecisionHash: string | undefined
    const decisions: {
      observedAt: string
      status: string
      symbol?: string
      snapshotHash?: string
      selectionHash?: string
      exclusions?:
        | StrategyMarketSnapshot['manifest']['candidateExclusions']
        | Extract<
            Result.Result.Success<ReturnType<typeof selectBoundRidge>>,
            { status: 'AVAILABLE' }
          >['evidence']['exclusions']
      cause?: unknown
      management?: { batchId: string; decisionHash: string; decidedAt: string; committedAt: string }
      nativeEntry?: { batchId: string; observationHash: string; decisionHash: string; committedAt: string }
    }[] = []
    const orders: {
      submittedAt: string
      arrivedAt: string
      side: OrderSide
      symbol: string
      requestedQuantityAtoms: string
      outcome: unknown
    }[] = []
    const trainingAttempts: RidgeTrainingAttempt[] = []
    let pendingTraining:
      | (Omit<RidgeTrainingAttempt, 'outcome' | 'reason' | 'completeAt' | 'netExecutionPnlMicros' | 'orders'> & {
          firstOrder: number
        })
      | null = null
    const finishTraining = (outcome: RidgeTrainingOutcome, reason: string, atMs: number) => {
      if (pendingTraining === null) return
      const { firstOrder, ...attempt } = pendingTraining
      trainingAttempts.push({
        ...attempt,
        outcome,
        reason,
        completeAt: outcome === RidgeTrainingOutcome.Unresolved ? null : utcInstantFromEpochMillis(atMs),
        netExecutionPnlMicros:
          outcome === RidgeTrainingOutcome.Unresolved
            ? null
            : outcome === RidgeTrainingOutcome.NoEntryFill
              ? '0'
              : String(BigInt(portfolio.ledger.cashMicros) - BigInt(attempt.openingCashMicros)),
        orders: orders.slice(firstOrder),
      })
      pendingTraining = null
    }
    const marks: {
      observedAt: string
      brokerEquityMicros: string | null
      netEquityAfterKnownCostsMicros: string | null
      quoteHash: string | null
      cause: string | null
    }[] = []
    let missingDecisions = 0
    let missingExecutionQuotes = 0
    let nextMarkMs = openMs
    const mark = (atMs: number) =>
      Effect.gen(function* () {
        const position = portfolio.ledger.positions[0]
        const quote = position === undefined ? undefined : yield* market.quoteAt(position.symbol, atMs)
        const rejection =
          position === undefined
            ? null
            : (replayQuoteRejection(quote, position.symbol, atMs, { ...protocol, ...equityMarketProfile }) ??
              (quote !== undefined && Number.isFinite(quote.value.bidSize) && quote.value.bidSize > 0
                ? null
                : 'no-displayed-bid-liquidity'))
        if (rejection !== null) {
          marks.push({
            observedAt: utcInstantFromEpochMillis(atMs),
            brokerEquityMicros: null,
            netEquityAfterKnownCostsMicros: null,
            quoteHash: quote?.recordHash ?? null,
            cause: rejection,
          })
          return
        }
        const brokerEquity =
          BigInt(portfolio.ledger.cashMicros) +
          (position !== undefined && quote !== undefined
            ? (BigInt(position.quantityAtoms) * (yield* Effect.fromResult(numberToMicros(quote.value.bidPrice)))) /
              1_000_000_000n
            : 0n)
        const netEquity = brokerEquity - accruedExternalCost - BigInt((yield* modelCosts(atMs)).knownCostMicros)
        if (brokerEquity > peakBrokerEquity) peakBrokerEquity = brokerEquity
        if (netEquity > peakNetEquity) peakNetEquity = netEquity
        if (peakNetEquity - netEquity > maximumDrawdown) maximumDrawdown = peakNetEquity - netEquity
        if (openingNetEquity - netEquity > maximumSessionLoss) maximumSessionLoss = openingNetEquity - netEquity
        marks.push({
          observedAt: utcInstantFromEpochMillis(atMs),
          brokerEquityMicros: String(brokerEquity),
          netEquityAfterKnownCostsMicros: String(netEquity),
          quoteHash: quote?.recordHash ?? null,
          cause: null,
        })
      })
    const advanceTo = (atMs: number) =>
      Effect.gen(function* () {
        while (nextMarkMs <= Math.min(atMs, closeMs)) {
          yield* market.advanceTo(nextMarkMs)
          yield* mark(nextMarkMs)
          nextMarkMs += 60_000
        }
        yield* market.advanceTo(atMs)
        if (atMs <= closeMs && marks.at(-1)?.observedAt !== utcInstantFromEpochMillis(atMs)) yield* mark(atMs)
      })
    const nativeJev =
      jevBinding === null
        ? null
        : yield* makeControlJev(jevBinding.binding, (atMs) =>
            advanceTo(atMs).pipe(
              Effect.mapError(
                (cause) => new ControlStudyFailure({ message: 'Cannot mark control management time', cause }),
              ),
            ),
          )
    let atMs = openMs
    let nextPollMs = openMs
    while (atMs < closeMs) {
      const pollOrdinal = (atMs - openMs) / input.pollIntervalMs
      yield* advanceTo(atMs)
      const held = portfolio.ledger.positions[0]
      portfolio = yield* Effect.fromResult(
        triggerControlExit({
          feeMultiplierPpm: assumptions.feeMultiplierPpm,
          portfolio,
          policy: input.policy,
          protocol,
          atMs,
          cutoffMs,
          quote: held === undefined ? undefined : yield* market.quoteAt(held.symbol, atMs),
        }),
      )
      let symbol: string | null = null
      let side = OrderSide.Buy
      let disposition: ControlPollDisposition
      if (portfolio.inventory.status === 'EXITING') {
        disposition = ControlPollDisposition.Exiting
        symbol = held?.symbol ?? null
        side = OrderSide.Sell
      } else if (portfolio.inventory.status === 'FLAT' && atMs >= warmupMs && atMs < cutoffMs) {
        disposition = ControlPollDisposition.WindowAlreadyConsumed
        const rangeEndMs = Math.floor((atMs - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
        if (rangeEndMs > lastWindow) {
          const observedAt = utcInstantFromEpochMillis(atMs)
          const candidates =
            input.training === undefined ? controlCandidates(input.policy, protocol) : [input.training.candidateSymbol]
          const query = makeJevEntryQuery({
            protocol,
            sessionDate,
            calendar: input.calendar,
            observedAtMs: atMs,
            candidates,
          })
          const adapter:
            | {
                readonly select: (
                  query: IntradaySnapshotQuery,
                ) => Effect.Effect<
                  Result.Result.Success<ReturnType<typeof selectBoundRidge>> | RidgeTrainingSelection,
                  ControlStudyFailure
                >
              }
            | undefined = input.ridge ?? input.training
          const observed =
            adapter === undefined
              ? yield* market.snapshot(query)
              : yield* adapter
                  .select(query)
                  .pipe(
                    Effect.map((selection) =>
                      selection.status === 'UNAVAILABLE'
                        ? { status: 'UNAVAILABLE' as const, cause: selection.observations }
                        : { status: 'AVAILABLE' as const, ridge: selection },
                    ),
                  )
          if (observed.status === 'UNAVAILABLE') {
            disposition = ControlPollDisposition.InputUnavailable
            missingDecisions += 1
            decisions.push({
              observedAt,
              status: 'UNAVAILABLE',
              cause: yield* Effect.fromResult(failureDetails(observed.cause)),
            })
          } else {
            const exclusions =
              'snapshot' in observed
                ? (observed.snapshot.manifest.candidateExclusions ?? [])
                : observed.ridge.evidence.exclusions
            if (exclusions.length > 0) {
              opportunities.entrySnapshotsWithCandidateExclusions++
              opportunities.excludedCandidateObservationCount += exclusions.length
            }
            lastWindow = rangeEndMs
            let nativeEntry: {
              readonly symbol: string | null
              readonly decisionHash: string
              readonly committedAtMs: number
              readonly batchId: string
              readonly observationHash: string
            } | null = null
            let nativeEntryCause: unknown = 'Native entry adapter is unavailable'
            if (
              input.policy === ControlPolicy.JevEntry &&
              input.entry !== undefined &&
              nativeJev !== null &&
              'snapshot' in observed
            ) {
              const result = yield* nativeJev.evaluateEntry({
                runId: input.entry.runId,
                protocol,
                snapshot: observed.snapshot,
                portfolio,
              })
              atMs = yield* Clock.currentTimeMillis
              if (result.status === 'DECIDED') nativeEntry = result
              else nativeEntryCause = result.cause
            }
            const selected: Result.Result<
              {
                symbol: string | null
                evidence:
                  | Result.Result.Success<ReturnType<typeof selectResidualShock>>
                  | Extract<
                      Result.Result.Success<ReturnType<typeof selectBoundRidge>>,
                      { status: 'AVAILABLE' }
                    >['evidence']
                  | Extract<RidgeTrainingSelection, { status: 'AVAILABLE' }>['evidence']
                  | null
              },
              ControlStudyFailure
            > =
              input.policy === ControlPolicy.JevEntry
                ? nativeEntry === null
                  ? Result.fail(
                      new ControlStudyFailure({
                        message: 'Native entry did not produce a usable committed decision',
                        cause: nativeEntryCause,
                      }),
                    )
                  : Result.succeed({ symbol: nativeEntry.symbol, evidence: null })
                : 'ridge' in observed
                  ? Result.succeed({
                      symbol: observed.ridge.evidence.selectedSymbol,
                      evidence: observed.ridge.evidence,
                    })
                  : input.policy === ControlPolicy.ResidualShock
                    ? selectResidualShock(observed.snapshot, protocol).pipe(
                        Result.map((evidence) => ({ symbol: evidence.selectedSymbol, evidence })),
                        Result.mapError(
                          (cause) => new ControlStudyFailure({ message: 'Cannot select residual shock', cause }),
                        ),
                      )
                    : selectControlSymbol(observed.snapshot, input.policy, protocol).pipe(
                        Result.map((symbol) => ({ symbol, evidence: null })),
                      )
            if (Result.isFailure(selected)) {
              disposition = ControlPollDisposition.SelectionUnavailable
              missingDecisions += 1
              decisions.push({
                observedAt,
                status: 'UNAVAILABLE',
                cause: yield* Effect.fromResult(failureDetails(selected.failure)),
              })
            } else {
              symbol = selected.success.symbol
              disposition = symbol === null ? ControlPollDisposition.NoSignal : ControlPollDisposition.Selected
              const selectionIdentity =
                'snapshot' in observed
                  ? { snapshotHash: observed.snapshot.manifest.contentHash }
                  : { selectionHash: observed.ridge.evidenceHash }
              lastEntryDecisionHash =
                nativeEntry?.decisionHash ??
                (yield* Effect.fromResult(
                  canonicalHashV1Result({
                    policy: input.policy,
                    observedAt,
                    symbol,
                    ...selectionIdentity,
                  }),
                ))
              if (
                input.training !== undefined &&
                'ridge' in observed &&
                'feature' in observed.ridge.evidence &&
                observed.ridge.evidence.feature !== null
              ) {
                if (pendingTraining !== null)
                  return yield* new ControlStudyFailure({
                    message: 'Training attempted to replace an unresolved entry binding',
                  })
                pendingTraining = {
                  features: observed.ridge.evidence.feature,
                  decisionHash: lastEntryDecisionHash,
                  selectionHash: observed.ridge.evidenceHash,
                  openingCashMicros: portfolio.ledger.cashMicros,
                  openingTurnoverMicros: String(portfolio.tradedNotionalMicros),
                  firstOrder: orders.length,
                }
              }
              decisions.push({
                observedAt,
                status: symbol === null ? 'NO_SIGNAL' : 'SELECTED',
                ...(symbol === null ? {} : { symbol }),
                ...selectionIdentity,
                exclusions,
                ...(nativeEntry === null
                  ? {}
                  : {
                      nativeEntry: {
                        batchId: nativeEntry.batchId,
                        observationHash: nativeEntry.observationHash,
                        decisionHash: nativeEntry.decisionHash,
                        committedAt: utcInstantFromEpochMillis(nativeEntry.committedAtMs),
                      },
                    }),
                ...(selected.success.evidence === null ? {} : { signal: selected.success.evidence }),
              })
              if (input.policy !== ControlPolicy.JevEntry) {
                atMs = Math.min(atMs + input.decisionLatencyMs, closeMs)
                yield* advanceTo(atMs)
              }
              if (atMs >= cutoffMs || atMs - Date.parse(observedAt) >= protocol.inferenceValidityMs) {
                decisions.push({ observedAt: utcInstantFromEpochMillis(atMs), status: 'DECISION_EXPIRED' })
                finishTraining(RidgeTrainingOutcome.NoEntryFill, 'DECISION_EXPIRED', atMs)
                symbol = null
              }
            }
          }
        }
      } else
        disposition =
          portfolio.inventory.status === 'HOLDING'
            ? ControlPollDisposition.Holding
            : atMs < warmupMs
              ? ControlPollDisposition.Warmup
              : ControlPollDisposition.EntryCutoff
      if (symbol !== null && atMs + assumptions.latencyMs < closeMs) {
        const decisionQuote = yield* market.quoteAt(symbol, atMs)
        const rejection = replayQuoteRejection(decisionQuote, symbol, atMs, { ...protocol, ...equityMarketProfile })
        if (rejection !== null || decisionQuote === undefined) {
          missingExecutionQuotes += 1
          decisions.push({
            observedAt: utcInstantFromEpochMillis(atMs),
            status: 'MISSING_PRICING',
            symbol,
            cause: rejection,
          })
          if (side === OrderSide.Buy) finishTraining(RidgeTrainingOutcome.Unresolved, 'MISSING_PRICING', atMs)
        } else {
          const riskBlocked =
            side === OrderSide.Buy &&
            (!input.eligibleSymbols.has(symbol) ||
              openingCash - BigInt(portfolio.ledger.cashMicros) > BigInt(risk.maxDailyLossMicros) ||
              peakBrokerEquity - BigInt(portfolio.ledger.cashMicros) > BigInt(risk.maxDrawdownMicros))
          const quantity = riskBlocked
            ? 0n
            : side === OrderSide.Sell
              ? BigInt(held?.quantityAtoms ?? '0')
              : yield* Effect.fromResult(
                  controlEntryQuantity({
                    instruments: assumptions.instruments,
                    portfolio,
                    policy: risk,
                    protocol,
                    targetWeight: input.targetWeight,
                    symbol,
                    referencePriceMicros: yield* Effect.fromResult(numberToMicros(decisionQuote.value.askPrice)),
                    atMs,
                    feeMultiplierPpm: assumptions.feeMultiplierPpm,
                    ...(input.turnoverPolicy === undefined ? {} : { turnoverPolicy: input.turnoverPolicy }),
                    ...(fixedPrincipalBudget === undefined
                      ? {}
                      : { allocationBudgetMicros: BigInt(fixedPrincipalBudget) }),
                  }),
                )
          if (quantity > 0n) {
            const submittedAtMs = atMs
            atMs += assumptions.latencyMs
            yield* advanceTo(atMs)
            const entryOrder: Parameters<typeof applyControlOrder>[1] = {
              symbol,
              side,
              quantityAtoms: quantity,
              protocol,
              assumptions,
              decisionQuote,
              arrivalQuote: yield* market.quoteAt(symbol, atMs),
              decisionAtMs: submittedAtMs,
              arrivalAtMs: atMs,
            }
            const result = yield* Effect.fromResult(applyControlOrder(portfolio, entryOrder))
            portfolio = result.portfolio
            yield* mark(atMs)
            if (result.outcome.status === 'UNRESOLVED') missingExecutionQuotes += 1
            orders.push({
              submittedAt: utcInstantFromEpochMillis(submittedAtMs),
              arrivedAt: utcInstantFromEpochMillis(atMs),
              side,
              symbol,
              requestedQuantityAtoms: String(quantity),
              outcome: result.outcome,
            })
            if (side === OrderSide.Buy && result.outcome.status !== 'FILLED')
              finishTraining(
                result.outcome.status === 'CANCELED'
                  ? RidgeTrainingOutcome.NoEntryFill
                  : RidgeTrainingOutcome.Unresolved,
                result.outcome.status,
                atMs,
              )
            else if (side === OrderSide.Sell && portfolio.inventory.status === 'FLAT')
              finishTraining(RidgeTrainingOutcome.Resolved, 'FLAT', atMs)
          } else {
            decisions.push({ observedAt: utcInstantFromEpochMillis(atMs), status: 'RISK_OR_CAPITAL_BLOCKED', symbol })
            if (side === OrderSide.Buy)
              finishTraining(RidgeTrainingOutcome.NoEntryFill, 'RISK_OR_CAPITAL_BLOCKED', atMs)
          }
        }
      }
      nextPollMs += Math.max(1, Math.ceil((atMs - nextPollMs) / input.pollIntervalMs)) * input.pollIntervalMs
      yield* Effect.fromResult(accountPollRange(pollOrdinal, pollOrdinal + 1, disposition))
      opportunities.engineStartedPollCount++
      yield* Effect.fromResult(
        accountPollRange(
          pollOrdinal + 1,
          Math.min((nextPollMs - openMs) / input.pollIntervalMs, opportunities.scheduledPollCount),
          ControlPollDisposition.SkippedWhileBusy,
        ),
      )
      atMs = Math.max(atMs, Math.min(nextPollMs, closeMs))
    }
    if (opportunities.accountedPollCount !== opportunities.scheduledPollCount)
      return yield* new ControlStudyFailure({ message: 'Control opportunity coverage does not reach session close' })
    yield* advanceTo(Math.max(atMs, closeMs))
    finishTraining(RidgeTrainingOutcome.Unresolved, 'SESSION_ENDED_BEFORE_RESOLUTION', atMs)
    const sessionModelCosts = yield* modelCosts(Number.POSITIVE_INFINITY)
    const totalExternalCost = accruedExternalCost + BigInt(sessionModelCosts.knownCostMicros)
    const issues = [
      ...(missingDecisions > 0 ? ['MISSING_DECISION_DATA'] : []),
      ...(missingExecutionQuotes > 0 ? ['MISSING_EXECUTION_QUOTES'] : []),
      ...(marks.some((entry) => entry.netEquityAfterKnownCostsMicros === null) ? ['MISSING_VALUATION'] : []),
      ...(portfolio.ledger.positions.length > 0 ? ['UNCLOSED_POSITION'] : []),
      ...(input.dataCostMicros === null ? ['UNPRICED_DATA_ALLOCATION'] : []),
      ...(sessionModelCosts.unresolvedCallCount > 0 ? ['UNPRICED_MODEL_CALLS'] : []),
      ...(atMs > closeMs ? ['MANAGEMENT_AFTER_CLOSE'] : []),
    ]
    const netPnl =
      portfolio.ledger.positions.length === 0
        ? String(BigInt(portfolio.ledger.cashMicros) - totalExternalCost - openingNetEquity)
        : null
    return {
      sessionDate: session.date,
      policy: input.policy,
      completion: issues.length === 0 ? ('COMPLETE' as const) : ('INCOMPLETE' as const),
      issues,
      ...(fixedPrincipalBudget === undefined
        ? { targetWeight: input.targetWeight }
        : {
            sizing: {
              mode: 'FIXED_PRINCIPAL_BUDGET' as const,
              allocationBudgetMicros: fixedPrincipalBudget,
            },
          }),
      completedEpisodes: portfolio.episodes.length,
      filledNotionalMicros: String(portfolio.tradedNotionalMicros),
      netPnlAfterKnownCostsMicros: netPnl,
      allCostNetPnlMicros: input.dataCostMicros === null || sessionModelCosts.unresolvedCallCount > 0 ? null : netPnl,
      netAfterAdditional10BpsMicros:
        netPnl === null ? null : String(BigInt(netPnl) - (portfolio.tradedNotionalMicros + 999n) / 1000n),
      executionFeesMicros: portfolio.ledger.executionFeesMicros,
      modelCostMicros: sessionModelCosts.unresolvedCallCount === 0 ? sessionModelCosts.knownCostMicros : null,
      knownModelCostMicros: sessionModelCosts.knownCostMicros,
      modelCallCount: sessionModelCosts.callCount,
      unpricedModelCallCount: sessionModelCosts.unresolvedCallCount,
      managementMode: ControlManagementMode.Mechanical,
      entryMode: input.policy === ControlPolicy.JevEntry ? ControlEntryMode.Jev : ControlEntryMode.Deterministic,
      dataCostMicros: input.dataCostMicros,
      maximumMarkedDrawdownMicros: String(maximumDrawdown),
      maximumMarkedSessionLossMicros: String(maximumSessionLoss),
      closingCapital: {
        cashMicros: portfolio.ledger.cashMicros,
        peakBrokerEquityMicros: String(peakBrokerEquity),
        peakNetEquityMicros: String(peakNetEquity),
        accruedExternalCostMicros: String(totalExternalCost),
      } satisfies ControlCapital,
      missingDecisions,
      missingExecutionQuotes,
      ledger: portfolio.ledger,
      episodes: portfolio.episodes,
      decisions,
      orders,
      marks,
      simulatedOpportunityAccounting: opportunities,
      ...(input.training === undefined
        ? {}
        : { trainingCandidateSymbol: input.training.candidateSymbol, trainingAttempts }),
    }
  }).pipe(Effect.mapError((cause) => new ControlStudyFailure({ message: 'Control session failed', cause })))

export const prepareControlStudy = (raw: unknown, receipt: BacktestSourceReceipt) =>
  Result.gen(function* () {
    const input = yield* Schema.decodeUnknownResult(ControlStudyInputSchema, strictParseOptions)(raw)
    const prepared = yield* prepareBacktest(input.backtest, receipt)
    if (prepared.brokerSessions.length === 0)
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'Control interval must contain a complete regular broker session' }),
      )
    const dataCostMicros = prepared.input.allocatedDataCostPerSessionMicros
    if (dataCostMicros === null && (input.costObjective !== 'KNOWN_COST_DIAGNOSTIC' || input.ridge !== undefined))
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'Control net outcomes require a priced data allocation' }),
      )
    const falsification = input.falsificationCandidate != null
    if (
      falsification &&
      (prepared.input.cadence.pollIntervalMs !== residualShockDefinition.pollIntervalMs ||
        equityMarketProfile.maximumEntrySpreadBps !== residualShockDefinition.maximumSpreadBps ||
        controlExitDefinition.protectiveStopBps !== residualShockDefinition.protectiveStopBps ||
        prepared.protocol.holdingMinutes[MarketKind.Equity] !== 15 ||
        prepared.protocol.flattenBeforeCloseMinutes !== residualShockDefinition.flattenMinutesBeforeClose)
    )
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'Frozen residual shock cadence or native protective rules differ' }),
      )
    const policyDefinition = falsification ? residualShockControlStudyDefinition : controlStudyDefinition
    if (
      falsification &&
      (input.management !== ControlManagementMode.Mechanical ||
        input.repeatedTargetWeightPpm !== residualShockDefinition.targetWeightPpm)
    )
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'Residual shock requires frozen mechanical sizing' }),
      )
    if (
      input.entry === ControlEntryMode.Jev &&
      input.repeatedTargetWeightPpm !==
        Math.floor(Math.min(prepared.protocol.maximumGrossWeight, prepared.protocol.maximumSymbolWeight) * 1_000_000)
    )
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'Jev entry and momentum must use the same native allocation' }),
      )
    const definition = {
      ...(input.ridge !== undefined ? ridgeControlStudyDefinition : policyDefinition),
      schemaVersion: 'bayn.control-study-definition.v12',
      entry: input.entry,
      opportunityAccounting: opportunityAccountingDefinition,
      nativeEntry:
        'Jev entry uses the native observation, batch and decision against its independent flat ledger. Provider and fsync journal work advance the market clock before execution. Mechanical exits isolate entry selection; no response is reused across portfolios.',
    }
    if (prepared.input.cadence.pollIntervalMs > 60_000 || prepared.input.assumptions.latencyMs > 60_000)
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'Control polling and routing latency must each be at most one minute' }),
      )
    return { input, prepared, falsification, definition, dataCostMicros }
  })

export const runControlStudy = (
  raw: unknown,
  arrivalsPath: string,
  receipt: BacktestSourceReceipt,
  management: ControlStudyManagement,
) =>
  Effect.gen(function* () {
    const { input, prepared, falsification, definition, dataCostMicros } = yield* Effect.fromResult(
      prepareControlStudy(raw, receipt),
    )
    if (input.management !== management.mode)
      return yield* new ControlStudyFailure({ message: 'Control management binding differs from its frozen input' })
    if ((input.entry === ControlEntryMode.Jev) !== 'provider' in management)
      return yield* new ControlStudyFailure({
        message: 'Native Jev entry requires exactly one measured provider binding',
      })
    const risk = yield* loadExecutionRiskPolicy(prepared.identity.accountId, equityMarketProfile.universe)
    const firstDate = prepared.brokerSessions[0]?.date
    const lastDate = prepared.input.calendar.at(-1)?.date
    if (firstDate === undefined || lastDate === undefined)
      return yield* new ControlStudyFailure({ message: 'Control calendar has no boundary sessions' })
    const calendar = yield* Effect.fromResult(
      normalizeMarketCalendarResult(prepared.input.calendar, {
        start: yield* Effect.fromResult(Schema.decodeUnknownResult(IsoDateSchema)(firstDate)),
        end: lastDate,
      }),
    )
    const boundRidge =
      input.ridge !== undefined
        ? yield* Effect.fromResult(
            prepareBoundRidge(input.ridge, {
              source: prepared.input.source,
              calendar,
              sessions: prepared.brokerSessions,
              protocol: prepared.protocol,
              risk,
              pollIntervalMs: prepared.input.cadence.pollIntervalMs,
              decisionLatencyMs: input.decisionLatencyMs,
              turnoverPolicy: input.turnoverPolicy,
              assumptions: prepared.input.assumptions,
            }),
          )
        : null
    const runId = yield* Effect.fromResult(
      canonicalHashV1Result({ input, receiptHash: receipt.contentHash, definition, risk }),
    )
    if ('provider' in management) {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(management.evidenceDirectory)
      yield* Effect.gen(function* () {
        const file = yield* fs.open(`${management.evidenceDirectory}/registration.json`, { flag: 'wx' })
        yield* file.writeAll(
          new TextEncoder().encode(
            `${JSON.stringify({ runId, input, sourceReceiptHash: receipt.contentHash, definition, risk })}\n`,
          ),
        )
        yield* file.sync
        const directory = yield* fs.open(management.evidenceDirectory, { flag: 'r' })
        yield* directory.sync
      }).pipe(Effect.scoped)
    }
    const sessions = []
    for (const policy of boundRidge !== null
      ? [ControlPolicy.Ridge, ControlPolicy.TrainingMean]
      : falsification
        ? [...deterministicControlPolicies, ControlPolicy.ResidualShock]
        : input.entry === ControlEntryMode.Jev
          ? [...deterministicControlPolicies, ControlPolicy.JevEntry]
          : deterministicControlPolicies) {
      const results = yield* Effect.gen(function* () {
        yield* TestClock.setTime(prepared.openMs)
        const controlRunId = yield* Effect.fromResult(canonicalHashV1Result({ runId, policy }))
        const binding =
          'provider' in management && policy === ControlPolicy.JevEntry
            ? {
                runId: controlRunId,
                costs: prepared.input.inference.costs,
                binding: {
                  provider: management.provider,
                  providerClock: management.providerClock,
                  journal: yield* makeControlJevJournal(`${management.evidenceDirectory}/${policy}`, controlRunId),
                },
              }
            : null
        const source = yield* openBacktestSource(arrivalsPath, prepared.input.source, runId, receipt)
        const market: ControlMarket = {
          advanceTo: (atMs) =>
            source.advanceTo(atMs).pipe(
              Effect.andThen(TestClock.setTime(atMs)),
              Effect.mapError((cause) => new ControlStudyFailure({ message: 'Cannot advance control source', cause })),
            ),
          quoteAt: (symbol, atMs) =>
            source.cursor.pipe(Effect.map((cursor) => observedQuoteAt(cursor.projection, symbol, atMs))),
          snapshot: (query) =>
            source.cursor.pipe(
              Effect.map((cursor) => {
                const result = constructSimulatedSnapshot(cursor, source.source, query)
                return Result.isSuccess(result)
                  ? { status: 'AVAILABLE' as const, snapshot: result.success }
                  : { status: 'UNAVAILABLE' as const, cause: result.failure }
              }),
            ),
        }
        const results = []
        let capital: ControlCapital = {
          cashMicros: prepared.input.openingCashMicros,
          peakBrokerEquityMicros: prepared.input.openingCashMicros,
          peakNetEquityMicros: prepared.input.openingCashMicros,
          accruedExternalCostMicros: '0',
        }
        for (const session of prepared.brokerSessions) {
          const result = yield* runControlSession({
            policy,
            protocol: prepared.protocol,
            risk,
            session,
            calendar,
            openingCapital: capital,
            dataCostMicros,
            targetWeight:
              input.ridge !== undefined
                ? 1
                : policy === ControlPolicy.RetainedBreakout
                  ? 0.1
                  : input.repeatedTargetWeightPpm / 1_000_000,
            ...(boundRidge === null
              ? {}
              : {
                  ridge: {
                    bound: boundRidge,
                    select: (query: IntradaySnapshotQuery) =>
                      source.cursor.pipe(
                        Effect.flatMap((cursor) =>
                          Effect.fromResult(
                            selectBoundRidge(
                              cursor,
                              query,
                              boundRidge,
                              policy === ControlPolicy.Ridge ? ControlPolicy.Ridge : ControlPolicy.TrainingMean,
                            ),
                          ),
                        ),
                        Effect.mapError(
                          (cause) => new ControlStudyFailure({ message: 'Cannot read Ridge entry', cause }),
                        ),
                      ),
                  },
                }),
            decisionLatencyMs: input.decisionLatencyMs,
            turnoverPolicy: input.turnoverPolicy,
            pollIntervalMs: prepared.input.cadence.pollIntervalMs,
            assumptions: prepared.input.assumptions,
            eligibleSymbols: new Set(
              prepared.assets
                .filter((asset) => asset.tradable && asset.status === AssetStatus.Active)
                .map((asset) => asset.symbol),
            ),
            market,
            management: policy === ControlPolicy.JevEntry ? null : binding,
            ...(policy === ControlPolicy.JevEntry && binding !== null ? { entry: binding } : {}),
          })
          results.push(result)
          if (result.ledger.positions.length !== 0 && session !== prepared.brokerSessions.at(-1))
            return yield* new ControlStudyFailure({
              message: 'Cannot reset an unresolved control position between sessions',
            })
          capital = result.closingCapital
        }
        yield* source.finish
        return results
      }).pipe(Effect.scoped)
      sessions.push(...results)
    }
    const report = {
      schemaVersion: 'bayn.control-study-report.v7',
      ...(boundRidge === null
        ? {}
        : {
            qualification: 'UNQUALIFIED',
            controllerCoverage: 'UNKNOWN',
            executionLabelDefinition: ridgeExecutionLabelDefinition(
              {
                protocol: prepared.protocol,
                risk,
                pollIntervalMs: prepared.input.cadence.pollIntervalMs,
                decisionLatencyMs: input.decisionLatencyMs,
                turnoverPolicy: input.turnoverPolicy,
                assumptions: prepared.input.assumptions,
              },
              boundRidge.artifact.allocationBudgetMicros,
            ),
          }),
      classification: 'DEVELOPMENT_CONTROL_PORTFOLIOS',
      costObjective: input.costObjective,
      qualification: 'UNQUALIFIED',
      runId,
      definition,
      input,
      sourceReceiptHash: receipt.contentHash,
      risk,
      sessions,
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  })
