import { Result, Schema } from 'effect'

import { makeExecutionCalendarObservation } from '../../cycle/construction'
import { canonicalHashV1Result, sha256 } from '../../hash'
import type {
  IntradayBar,
  IntradayCandidateExclusion,
  IntradayQuote,
  IntradayTrade,
} from '../../market-data/intraday/model'
import type { StrategyMarketSnapshot } from '../../market-data/streaming/snapshot'
import { compareIntradayInstants, intradayInstantNanos } from '../../market-data/intraday/time'
import { strictParseOptions, UtcInstantSchema } from '../../schemas'
import type { VerifiedStrategyContext } from '../core'
import {
  IntradayMomentumFailure,
  type IntradayMomentumMarketContext,
  type IntradayMomentumStrategyDefinition,
  type IntradayMomentumTargetPortfolio,
} from './model'
import {
  decideIntradayMomentumCore,
  type IntradayMomentumCoreBar,
  type IntradayMomentumCoreQuote,
  type IntradayMomentumCoreTrade,
} from './decision-core'
import {
  intradayMomentumSessionHasDecisionInterval,
  intradayMomentumSnapshotSymbols,
  type IntradayMomentumProtocol,
} from './protocol'

const minuteMs = 60_000

export const intradayMomentumBehaviorVersion = 'bayn.intraday-momentum.behavior.v14' as const
export const intradayMomentumBehaviorHash = sha256(intradayMomentumBehaviorVersion)

const compareCanonicalText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareLatest = <T extends IntradayQuote | IntradayTrade>(left: T, right: T): number => {
  const eventOrder = compareIntradayInstants(right.eventAt, left.eventAt)
  if (eventOrder !== 0) return eventOrder
  const topicOrder = compareCanonicalText(right.sourceTopic, left.sourceTopic)
  if (topicOrder !== 0) return topicOrder
  const partitionOrder = right.sourcePartition - left.sourcePartition
  if (partitionOrder !== 0) return partitionOrder
  const leftOffset = BigInt(left.sourceOffset)
  const rightOffset = BigInt(right.sourceOffset)
  return rightOffset > leftOffset ? 1 : rightOffset < leftOffset ? -1 : 0
}

const fail = (
  reason: IntradayMomentumFailure['reason'],
  message: string,
  details: Pick<IntradayMomentumFailure, 'symbol' | 'field' | 'observed'> = {},
): Result.Result<never, IntradayMomentumFailure> =>
  Result.fail(new IntradayMomentumFailure({ reason, message, ...details }))

type IntradayMomentumEnvelopeContext = {
  readonly snapshot: StrategyMarketSnapshot
  readonly session: IntradayMomentumMarketContext['session']
}

type CandidateEnvelope = {
  readonly independent: boolean
  readonly exclusions: ReadonlyMap<string, IntradayCandidateExclusion>
}

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const validateCandidateEnvelope = (
  manifest: StrategyMarketSnapshot['manifest'],
  protocol: IntradayMomentumProtocol,
): Result.Result<CandidateEnvelope, IntradayMomentumFailure> => {
  const hasCandidates = manifest.candidateSymbols !== undefined
  const hasExclusions = manifest.candidateExclusions !== undefined
  if (hasCandidates !== hasExclusions) {
    return fail('snapshot-identity', 'independent candidate metadata must be present together')
  }
  if (!hasCandidates || !hasExclusions) return Result.succeed({ independent: false, exclusions: new Map() })
  if (!sameStrings(manifest.candidateSymbols, protocol.candidateSymbols)) {
    return fail('snapshot-identity', 'independent candidate metadata does not bind the exact strategy candidates')
  }
  const candidates = new Set(protocol.candidateSymbols)
  const exclusions = new Map<string, IntradayCandidateExclusion>()
  for (const exclusion of manifest.candidateExclusions) {
    if (
      !candidates.has(exclusion.symbol) ||
      exclusion.symbol === protocol.benchmarkSymbol ||
      exclusion.message.trim().length === 0 ||
      (exclusion.reason !== 'not-ready' && exclusion.reason !== 'freshness') ||
      exclusions.has(exclusion.symbol)
    ) {
      return fail('snapshot-identity', 'independent candidate exclusions are not canonical or candidate-local', {
        symbol: exclusion.symbol,
      })
    }
    exclusions.set(exclusion.symbol, exclusion)
  }
  const exclusionSymbols = [...exclusions.keys()]
  if (!sameStrings(exclusionSymbols, [...exclusionSymbols].toSorted())) {
    return fail('snapshot-identity', 'independent candidate exclusions must be canonically ordered')
  }
  return Result.succeed({ independent: true, exclusions })
}

const validateSnapshot = (
  context: IntradayMomentumEnvelopeContext,
  protocol: IntradayMomentumProtocol,
): Result.Result<void, IntradayMomentumFailure> => {
  const { session, snapshot } = context
  const { manifest } = snapshot
  if ('streaming' in manifest) {
    const contract = protocol.streamingInput
    if (
      contract === undefined ||
      ('bootstrap' in manifest.streaming &&
        manifest.streaming.bootstrap.timestampPolicy !== contract.bootstrapTimestampPolicy) ||
      manifest.streaming.features.some(
        ({ value, topic }) =>
          topic !== contract.featureTopic ||
          value.material.definitionId !== contract.requiredDefinitionId ||
          value.material.definitionHash !== contract.requiredDefinitionHash,
      )
    )
      return fail('snapshot-identity', 'streaming evidence does not match the strategy input contract')
  }
  const snapshotSymbols = intradayMomentumSnapshotSymbols(protocol)
  const candidateEnvelope = validateCandidateEnvelope(manifest, protocol)
  if (Result.isFailure(candidateEnvelope)) return Result.fail(candidateEnvelope.failure)
  const boundSession = manifest.calendar.sessions.find(({ date }) => date === manifest.sessionDate)
  const selectedCalendar =
    boundSession === undefined
      ? undefined
      : makeExecutionCalendarObservation({
          schemaVersion: manifest.calendar.schemaVersion,
          source: manifest.calendar.source,
          ...boundSession,
        })
  if (
    manifest.universeId !== protocol.universeId ||
    manifest.universeSymbolHash !== protocol.universeSymbolHash ||
    manifest.feed !== protocol.feed ||
    manifest.delayClass !== protocol.delayClass ||
    manifest.sourceTopics.bars !== protocol.sourceTopics.bars ||
    manifest.sourceTopics.quotes !== protocol.sourceTopics.quotes ||
    manifest.sourceTopics.trades !== protocol.sourceTopics.trades ||
    manifest.maximumQuoteAgeMs !== protocol.maximumQuoteAgeMs ||
    manifest.universe === undefined ||
    manifest.universe.length !== protocol.universe.length ||
    manifest.universe.some((symbol, index) => symbol !== protocol.universe[index]) ||
    (candidateEnvelope.success.independent
      ? !manifest.symbols.includes(protocol.benchmarkSymbol) ||
        !protocol.candidateSymbols
          .filter((symbol) => !candidateEnvelope.success.exclusions.has(symbol))
          .every((symbol) => manifest.symbols.includes(symbol)) ||
        !sameStrings([...manifest.symbols].toSorted(), [...snapshotSymbols].toSorted())
      : snapshotSymbols.some((symbol) => !manifest.symbols.includes(symbol))) ||
    manifest.symbols.some((symbol) => !protocol.universe.includes(symbol))
  ) {
    return fail('snapshot-identity', 'intraday snapshot does not match the intraday-momentum protocol')
  }

  const rangeStart = Date.parse(manifest.rangeStartAt)
  const rangeEnd = Date.parse(manifest.rangeEndAt)
  const observed = Date.parse(manifest.observedAt)
  const sessionOpen = Date.parse(session.openAt)
  const sessionClose = Date.parse(session.closeAt)
  const earliestRangeEnd = sessionOpen + Math.max(protocol.warmupMinutesAfterOpen, protocol.lookbackMinutes) * minuteMs
  const entryCutoff = sessionClose - protocol.entryCutoffMinutesBeforeClose * minuteMs
  const earliestDecision = rangeEnd + protocol.decisionDelaySeconds * 1_000
  const latestDecision = earliestDecision + protocol.maximumDecisionLagMs
  const canonicalSessionInstants = Result.all([
    Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(session.openAt),
    Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(session.closeAt),
  ])
  if (
    Result.isFailure(canonicalSessionInstants) ||
    ![
      rangeStart,
      rangeEnd,
      observed,
      sessionOpen,
      sessionClose,
      earliestRangeEnd,
      entryCutoff,
      earliestDecision,
      latestDecision,
    ].every(Number.isSafeInteger) ||
    session.sessionDate !== manifest.sessionDate ||
    boundSession === undefined ||
    session.openAt !== boundSession.openAt ||
    session.closeAt !== boundSession.closeAt ||
    selectedCalendar === undefined ||
    Result.isFailure(selectedCalendar) ||
    session.calendarHash !== selectedCalendar.success.executionCalendarHash ||
    sessionOpen >= sessionClose ||
    !intradayMomentumSessionHasDecisionInterval(protocol, session) ||
    rangeStart < sessionOpen ||
    rangeEnd - rangeStart !== protocol.lookbackMinutes * minuteMs ||
    rangeEnd < earliestRangeEnd ||
    rangeEnd > entryCutoff ||
    observed < earliestDecision ||
    observed > latestDecision ||
    observed >= entryCutoff ||
    observed > sessionClose ||
    !/^[0-9a-f]{64}$/.test(session.calendarHash)
  ) {
    return fail('snapshot-window', 'intraday snapshot does not bind an eligible rolling decision window')
  }
  if (
    manifest.barCount !== snapshot.bars.length ||
    manifest.quoteCount !== snapshot.quotes.length ||
    manifest.tradeCount !== snapshot.trades.length ||
    snapshot.bars.length > manifest.symbols.length * protocol.lookbackMinutes ||
    snapshot.bars.some((bar) => !bar.final)
  ) {
    return fail('snapshot-coverage', 'intraday snapshot exceeds the bounded rolling decision evidence')
  }

  const rangeEndNanos = intradayInstantNanos(manifest.rangeEndAt)
  const observedNanos = intradayInstantNanos(manifest.observedAt)
  for (const symbol of snapshotSymbols) {
    const isBenchmark = symbol === protocol.benchmarkSymbol
    const excluded = candidateEnvelope.success.exclusions.has(symbol)
    const bars = snapshot.bars
      .filter((bar) => bar.symbol === symbol)
      .toSorted((left, right) => compareIntradayInstants(left.eventAt, right.eventAt))
    if (excluded) continue
    const missingBaseline =
      bars[0] === undefined || compareIntradayInstants(bars[0].eventAt, manifest.rangeStartAt) !== 0
    if (missingBaseline && (!candidateEnvelope.success.independent || isBenchmark)) {
      return fail('snapshot-coverage', 'intraday symbol lacks the complete rolling lookback baseline', { symbol })
    }
    for (const records of [
      snapshot.quotes.filter((quote) => quote.symbol === symbol).toSorted(compareLatest),
      snapshot.trades.filter((trade) => trade.symbol === symbol).toSorted(compareLatest),
    ] as const) {
      const latest = records[0]
      if (
        latest === undefined ||
        intradayInstantNanos(latest.eventAt) < rangeEndNanos ||
        intradayInstantNanos(latest.eventAt) > observedNanos
      ) {
        return fail('snapshot-coverage', 'intraday decision lacks post-window quote or trade evidence', { symbol })
      }
      if (
        records.some(
          (record) =>
            record !== latest &&
            compareIntradayInstants(record.eventAt, latest.eventAt) === 0 &&
            (record.sourceTopic !== latest.sourceTopic || record.sourcePartition !== latest.sourcePartition),
        )
      ) {
        return fail('snapshot-coverage', 'intraday latest evidence is ambiguous across Kafka partitions', { symbol })
      }
    }
  }
  return Result.succeed(undefined)
}

const toCoreBar = ({ symbol, eventAt, open, high, low }: IntradayBar): IntradayMomentumCoreBar => ({
  symbol,
  eventAt,
  open,
  high,
  low,
})

const toCoreQuote = ({
  symbol,
  eventAt,
  bidPrice,
  bidSize,
  askPrice,
  askSize,
}: IntradayQuote): IntradayMomentumCoreQuote => ({
  symbol,
  eventAt,
  bidPrice,
  bidSize,
  askPrice,
  askSize,
})

const toCoreTrade = ({ symbol, eventAt, price }: IntradayTrade): IntradayMomentumCoreTrade => ({
  symbol,
  eventAt,
  price,
})

const decideIntradayMomentumFromEnvelope = (
  context: IntradayMomentumEnvelopeContext,
  protocol: IntradayMomentumProtocol,
): Result.Result<IntradayMomentumTargetPortfolio, IntradayMomentumFailure> =>
  Result.gen(function* () {
    const snapshot = context.snapshot
    yield* validateSnapshot({ ...context, snapshot }, protocol)
    const candidateExclusions = snapshot.manifest.candidateExclusions
    const latestTrades = Object.fromEntries(
      protocol.candidateSymbols.flatMap((symbol) => {
        const trade = snapshot.trades.filter((candidate) => candidate.symbol === symbol).toSorted(compareLatest)[0]
        return trade === undefined ? [] : [[symbol, toCoreTrade(trade)] as const]
      }),
    )
    const core = yield* decideIntradayMomentumCore({
      ...('streaming' in snapshot.manifest
        ? {
            rollingPrices: Object.fromEntries(
              snapshot.manifest.streaming.features.map((feature) => [
                feature.value.material.symbol,
                feature.value.material.values,
              ]),
            ),
          }
        : {}),
      bars: snapshot.bars.map(toCoreBar),
      latestQuotes: Object.fromEntries(
        Object.entries(snapshot.latestQuotes).map(([symbol, quote]) => [symbol, toCoreQuote(quote)]),
      ),
      latestTrades,
      observedAt: snapshot.manifest.observedAt,
      rangeStartAt: snapshot.manifest.rangeStartAt,
      ...(candidateExclusions === undefined ? {} : { candidateExclusions }),
      protocol,
    })
    return Object.freeze({
      schemaVersion: 'bayn.intraday-momentum.target.v3',
      strategy: 'intraday-momentum',
      sessionDate: snapshot.manifest.sessionDate,
      snapshotId: snapshot.manifest.snapshotId,
      observedAt: snapshot.manifest.observedAt,
      calendarHash: context.session.calendarHash,
      ...core,
    })
  })

/** Execution decision boundary: only verified archive or streaming snapshots can produce targets. */
export const decideIntradayMomentum = (
  context: IntradayMomentumMarketContext,
  protocol: IntradayMomentumProtocol,
): Result.Result<IntradayMomentumTargetPortfolio, IntradayMomentumFailure> =>
  decideIntradayMomentumFromEnvelope(context, protocol)

/**
 * Pure durable-document verifier. It exposes no target portfolio and does not establish archive provenance; callers
 * use it only to prove that persisted rows reproduce an already-bound strategy-decision hash.
 */
export const verifyIntradayMomentumDecisionEnvelope = (
  context: IntradayMomentumEnvelopeContext,
  protocol: IntradayMomentumProtocol,
  expectedDecisionHash: string,
): Result.Result<void, IntradayMomentumFailure> =>
  Result.flatMap(decideIntradayMomentumFromEnvelope(context, protocol), (decision) =>
    Result.flatMap(
      Result.mapError(
        canonicalHashV1Result(decision),
        (cause) =>
          new IntradayMomentumFailure({
            reason: 'snapshot-identity',
            message: 'intraday decision evidence is not canonicalizable',
            cause,
          }),
      ),
      (decisionHash) =>
        decisionHash === expectedDecisionHash
          ? Result.succeed(undefined)
          : Result.fail(
              new IntradayMomentumFailure({
                reason: 'snapshot-identity',
                message: 'intraday decision evidence does not reproduce the bound strategy decision',
              }),
            ),
    ),
  )

export const makeIntradayMomentumDefinition = (
  protocol: IntradayMomentumProtocol,
): IntradayMomentumStrategyDefinition => ({
  name: 'intraday-momentum',
  holdingPeriod: 'INTRADAY',
  parameters: protocol,
  decide: (context: VerifiedStrategyContext<IntradayMomentumMarketContext>) =>
    decideIntradayMomentum(context.market, protocol),
})
