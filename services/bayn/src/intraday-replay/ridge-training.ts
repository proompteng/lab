import { Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { AssetStatus, MarketCalendarResponseSchema } from '../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { EntryTurnoverPolicy } from '../execution/turnover-reserve'
import { canonicalHashV1Result } from '../hash'
import { observedQuoteAt } from '../market-data/streaming/projection'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import {
  PositiveMicrosSchema,
  Sha256Schema,
  NonNegativeIntegerSchema,
  SymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import { BacktestInputSchema, prepareBacktest } from './backtest'
import { ControlPolicy, ControlStudyFailure } from './control-portfolio'
import { ridgeExecutionLabelDefinition } from './control-ridge'
import { failureDetails, runControlSession, type ControlCapital, type ControlMarket } from './control-study'
import { sixBarResearchDefinition } from './six-bar-features'
import { SixBarRidgePartition, SixBarRidgeSessionSchema, sixBarRidgeRecipe } from './six-bar-ridge'
import { fitSixBarRidge, SixBarRidgeLabelStatus, type SixBarRidgeTrainingRowSchema } from './six-bar-ridge-fit'
import { RidgeTrainingOutcome, selectRidgeTrainingCandidate } from './ridge-training-selection'
import { openBacktestSource, type BacktestSourceReceipt } from './source'

export const ridgeTrainingDefinition = {
  schemaVersion: 'bayn.ridge-training-definition.v1',
  sampling: 'INDEPENDENT_SERIAL_FIXED_CANDIDATES',
  behavior:
    'Each declared candidate has its own serial portfolio. Enter that candidate on each available flat eligible window; retain native stops, maximum hold and close exits.',
  capital:
    'Identical initial capital per counterfactual chain; carry its own cash, equity peaks and external costs across sessions. Daily turnover resets only at the session boundary.',
  labels:
    'Actual shared-engine execution cash delta divided by the unchanged fixed principal budget. Known no-entry outcomes are zero; unknown or unresolved outcomes are never zero.',
  limitations:
    'Policy-conditioned development labels, not a uniform candidate-time panel. Independent counterfactual chain P&Ls cannot be summed into one portfolio. No prospective qualification or trading authority.',
} as const

export const RidgeTrainingInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.ridge-training-input.v1'),
  sampling: Schema.Literal(ridgeTrainingDefinition.sampling),
  candidateSymbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  backtest: BacktestInputSchema,
  calendar: MarketCalendarResponseSchema,
  expectedCalendarHash: Sha256Schema,
  sessions: Schema.Array(SixBarRidgeSessionSchema).check(Schema.isMinLength(2)),
  fitCutoffAt: UtcInstantSchema,
  allocationBudgetMicros: PositiveMicrosSchema,
  decisionLatencyMs: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(60_000)),
  turnoverPolicy: Schema.Enum(EntryTurnoverPolicy),
})

const fail = (message: string, cause?: unknown) => new ControlStudyFailure({ message, cause })
export const prepareRidgeTraining = (raw: unknown, receipt: BacktestSourceReceipt) =>
  Result.gen(function* () {
    const input = yield* Schema.decodeUnknownResult(RidgeTrainingInputSchema, strictParseOptions)(raw)
    const prepared = yield* prepareBacktest(input.backtest, receipt)
    const firstDate = input.calendar[0]?.date,
      lastDate = input.calendar.at(-1)?.date
    if (firstDate === undefined || lastDate === undefined) return yield* Result.fail(fail('Training calendar is empty'))
    const calendar = yield* normalizeMarketCalendarResult(input.calendar, { start: firstDate, end: lastDate })
    const training = input.sessions.filter((session) => session.partition === SixBarRidgePartition.Training)
    const evaluation = input.sessions.find((session) => session.partition !== SixBarRidgePartition.Training)
    const declaredStart = calendar.sessions.findIndex((session) => session.date === input.sessions[0]?.date)
    const declaredEnd = calendar.sessions.findIndex((session) => session.date === input.sessions.at(-1)?.date)
    const declaredCalendar = calendar.sessions.slice(declaredStart, declaredEnd + 1)
    const trainingCalendar = input.calendar.slice(declaredStart, declaredStart + training.length + 1)
    const ranks = { TRAINING: 0, VALIDATION: 1, HOLDOUT: 2 } as const
    if (
      input.backtest.source.transport !== 'original-capture' ||
      input.backtest.source.deliveryModel.schemaVersion !== 'bayn.original-capture-arrivals.v1' ||
      calendar.normalizedResponseHash !== input.expectedCalendarHash ||
      input.candidateSymbols.join(',') !== prepared.protocol.candidateSymbols.join(',') ||
      !Number.isSafeInteger(Number(input.allocationBudgetMicros)) ||
      prepared.input.cadence.pollIntervalMs > 60_000 ||
      prepared.input.assumptions.latencyMs > 60_000 ||
      training.length !== prepared.sessions.length ||
      evaluation === undefined ||
      declaredStart < 0 ||
      declaredEnd < declaredStart ||
      declaredCalendar.length !== input.sessions.length ||
      declaredCalendar.some((session, index) => session.date !== input.sessions[index]?.date) ||
      JSON.stringify(prepared.input.calendar) !== JSON.stringify(trainingCalendar) ||
      training.some((session, index) => {
        const actual = prepared.sessions[index]
        return (
          actual === undefined ||
          session.date !== actual.date ||
          session.openAt !== actual.openAt ||
          session.closeAt !== actual.closeAt ||
          session.closeAt >= input.fitCutoffAt
        )
      }) ||
      input.fitCutoffAt > evaluation.firstDecisionAt ||
      input.backtest.source.coverageEndMs > Date.parse(input.fitCutoffAt) ||
      input.backtest.source.coverageEndMs >= Date.parse(evaluation.openAt) ||
      input.sessions.some((session, index) => {
        const previous = input.sessions[index - 1]
        const actual = calendar.sessions.find((value) => value.date === session.date)
        const firstPoll =
          Date.parse(session.openAt) +
          Math.ceil(
            (prepared.protocol.lookbackMinutes * 60_000 + prepared.protocol.decisionDelaySeconds * 1000) /
              prepared.input.cadence.pollIntervalMs,
          ) *
            prepared.input.cadence.pollIntervalMs
        return (
          actual === undefined ||
          actual.openAt !== session.openAt ||
          actual.closeAt !== session.closeAt ||
          session.firstDecisionAt !== utcInstantFromEpochMillis(firstPoll) ||
          (previous !== undefined &&
            (previous.date >= session.date ||
              previous.closeAt >= session.openAt ||
              ranks[previous.partition] > ranks[session.partition]))
        )
      })
    )
      return yield* Result.fail(
        fail(
          'Training requires original source, exact fixed candidates, causal whole-session partitions and pinned calendar',
        ),
      )
    return { input, prepared, calendar }
  })

export const runRidgeTraining = (raw: unknown, arrivalsPath: string, receipt: BacktestSourceReceipt) =>
  Effect.gen(function* () {
    const { input, prepared, calendar } = yield* Effect.fromResult(prepareRidgeTraining(raw, receipt))
    const risk = yield* loadQuoteBoundExecutionRiskPolicy(prepared.identity.accountId, prepared.protocol.universe)
    const executionLabelDefinition = ridgeExecutionLabelDefinition(
      {
        protocol: prepared.protocol,
        risk,
        pollIntervalMs: prepared.input.cadence.pollIntervalMs,
        decisionLatencyMs: input.decisionLatencyMs,
        turnoverPolicy: input.turnoverPolicy,
        assumptions: prepared.input.assumptions,
      },
      input.allocationBudgetMicros,
    )
    const runId = yield* Effect.fromResult(
      canonicalHashV1Result({
        input,
        receiptHash: receipt.contentHash,
        definition: ridgeTrainingDefinition,
        executionLabelDefinition,
        risk,
      }),
    )
    type SessionResult = Effect.Success<ReturnType<typeof runControlSession>>
    const chains: {
      candidateSymbol: string
      sessions: SessionResult[]
      skippedSessionDates: string[]
      failure: string | null
    }[] = []
    for (const candidateSymbol of input.candidateSymbols) {
      const chain: (typeof chains)[number] = { candidateSymbol, sessions: [], skippedSessionDates: [], failure: null }
      chains.push(chain)
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          yield* TestClock.setTime(prepared.openMs)
          const source = yield* openBacktestSource(arrivalsPath, prepared.input.source, runId, receipt)
          const market: ControlMarket = {
            advanceTo: (atMs) =>
              source.advanceTo(atMs).pipe(
                Effect.andThen(TestClock.setTime(atMs)),
                Effect.mapError((cause) => fail('Cannot advance training source', cause)),
              ),
            quoteAt: (symbol, atMs) =>
              source.cursor.pipe(Effect.map((cursor) => observedQuoteAt(cursor.projection, symbol, atMs))),
            snapshot: () => Effect.fail(fail('Training cannot use the legacy snapshot adapter')),
          }
          let capital: ControlCapital = {
            cashMicros: prepared.input.openingCashMicros,
            peakBrokerEquityMicros: prepared.input.openingCashMicros,
            peakNetEquityMicros: prepared.input.openingCashMicros,
            accruedExternalCostMicros: '0',
          }
          for (const [index, session] of prepared.sessions.entries()) {
            const result = yield* runControlSession({
              policy: ControlPolicy.FixedCandidateTraining,
              training: {
                candidateSymbol,
                allocationBudgetMicros: input.allocationBudgetMicros,
                select: (query) =>
                  source.cursor.pipe(
                    Effect.flatMap((cursor) =>
                      Effect.fromResult(selectRidgeTrainingCandidate(cursor, query, calendar, candidateSymbol)),
                    ),
                    Effect.mapError((cause) => fail('Cannot extract causal training features', cause)),
                  ),
              },
              protocol: prepared.protocol,
              risk,
              session,
              calendar,
              openingCapital: capital,
              dataCostMicros: prepared.input.allocatedDataCostPerSessionMicros,
              targetWeight: 1,
              management: null,
              accountScheduledOpportunities: true,
              decisionLatencyMs: input.decisionLatencyMs,
              pollIntervalMs: prepared.input.cadence.pollIntervalMs,
              turnoverPolicy: input.turnoverPolicy,
              assumptions: prepared.input.assumptions,
              eligibleSymbols: new Set(
                prepared.assets
                  .filter((asset) => asset.tradable && asset.status === AssetStatus.Active)
                  .map((asset) => asset.symbol),
              ),
              market,
            })
            chain.sessions.push(result)
            if (result.ledger.positions.length !== 0) {
              chain.skippedSessionDates = prepared.sessions.slice(index + 1).map((value) => value.date)
              break
            }
            capital = result.closingCapital
          }
          yield* source.finish
        }).pipe(Effect.scoped),
      )
      if (Result.isFailure(outcome)) {
        chain.failure = yield* Effect.fromResult(failureDetails(outcome.failure))
        chain.skippedSessionDates = prepared.sessions.slice(chain.sessions.length).map((value) => value.date)
      }
    }
    const rows: (typeof SixBarRidgeTrainingRowSchema.Type)[] = []
    let unresolvedAttempts = 0
    for (const chain of chains)
      for (const session of chain.sessions)
        for (const attempt of session.trainingAttempts ?? []) {
          if (
            attempt.outcome === RidgeTrainingOutcome.Unresolved ||
            attempt.completeAt === null ||
            attempt.netExecutionPnlMicros === null
          ) {
            unresolvedAttempts++
            continue
          }
          rows.push({
            features: attempt.features,
            label: {
              status:
                attempt.outcome === RidgeTrainingOutcome.NoEntryFill
                  ? SixBarRidgeLabelStatus.NoEntryFill
                  : SixBarRidgeLabelStatus.Resolved,
              netExecutionPnlMicros: attempt.netExecutionPnlMicros,
              completeAt: attempt.completeAt,
              evidenceHash: yield* Effect.fromResult(
                canonicalHashV1Result({
                  runId,
                  candidateSymbol: chain.candidateSymbol,
                  sessionDate: session.sessionDate,
                  attempt,
                }),
              ),
            },
          })
        }
    const rowHashes = yield* Effect.fromResult(Result.all(rows.map(canonicalHashV1Result)))
    const manifest = {
      schemaVersion: 'bayn.six-bar-ridge-training-manifest.v2',
      featureDefinitionHash: yield* Effect.fromResult(canonicalHashV1Result(sixBarResearchDefinition)),
      recipeHash: yield* Effect.fromResult(canonicalHashV1Result(sixBarRidgeRecipe)),
      provenance: {
        sourceRevision: prepared.input.build.sourceRevision,
        sourceManifestHash: yield* Effect.fromResult(canonicalHashV1Result(prepared.input.source)),
        labelDefinitionHash: yield* Effect.fromResult(canonicalHashV1Result(executionLabelDefinition)),
        calendarHash: calendar.normalizedResponseHash,
      },
      allocationBudgetMicros: input.allocationBudgetMicros,
      fitCutoffAt: input.fitCutoffAt,
      sessions: input.sessions.map((session) => ({
        ...session,
        requiredTrainingRowHashes: rows.flatMap((row, index) =>
          row.features.sessionDate === session.date && rowHashes[index] !== undefined ? [rowHashes[index]] : [],
        ),
      })),
    } as const
    const manifestHash = yield* Effect.fromResult(canonicalHashV1Result(manifest))
    const incomplete =
      unresolvedAttempts > 0 ||
      chains.some(
        (chain) =>
          chain.failure !== null ||
          chain.skippedSessionDates.length > 0 ||
          chain.sessions.some((session) => session.completion !== 'COMPLETE'),
      )
    const fit = incomplete || rows.length === 0 ? null : fitSixBarRidge(manifest, rows, manifestHash)
    const report = {
      schemaVersion: 'bayn.ridge-training-report.v1',
      qualification: 'UNQUALIFIED',
      controllerCoverage: 'UNKNOWN',
      classification: 'POLICY_CONDITIONED_DEVELOPMENT_TRAINING',
      status: incomplete
        ? 'INCOMPLETE'
        : rows.length === 0
          ? 'NO_TRAINING_ROWS'
          : fit !== null && Result.isSuccess(fit)
            ? 'FITTED'
            : 'FIT_FAILED',
      runId,
      input,
      definition: ridgeTrainingDefinition,
      executionLabelDefinition,
      risk,
      sourceReceiptHash: receipt.contentHash,
      chains,
      unresolvedAttempts,
      rows,
      manifest,
      manifestHash,
      manifestPinning:
        'The trusted extractor pins resolved rows before fitting. These post-outcome content pins are not independent prospective registration.',
      artifact: fit !== null && Result.isSuccess(fit) ? fit.success : null,
      fitFailure: fit !== null && Result.isFailure(fit) ? yield* Effect.fromResult(failureDetails(fit.failure)) : null,
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  }).pipe(
    Effect.mapError((cause) => fail('Ridge training failed before a complete report could be constructed', cause)),
  )
