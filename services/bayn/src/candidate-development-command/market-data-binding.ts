import { pipe, Result } from 'effect'
import { type CandidateDevelopmentPreflightInput, type CandidateDevelopmentReport } from '../candidate-development'
import { alignBars, type AlignedSession } from '../simulation'
import { type DailyBar } from '../types'
import type {
  CandidateDevelopmentCommandEvaluation,
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentMarketDataWitness,
  CandidateDevelopmentStrategyProtocol,
  CandidateDevelopmentVerifiedSource,
} from './contracts'
import { canonicalEvidenceHash, markedEquityFailure } from './evaluation-metrics'

export const requireCanonicalEvidenceEqual = (
  field: string,
  expected: unknown,
  observed: unknown,
): Result.Result<void, CandidateDevelopmentCommandFailure> =>
  pipe(
    Result.all({
      expected: canonicalEvidenceHash(`${field}.expected`, expected),
      observed: canonicalEvidenceHash(field, observed),
    }),
    Result.flatMap(({ expected: expectedHash, observed: observedHash }) =>
      expectedHash === observedHash
        ? Result.succeed(undefined)
        : Result.fail(markedEquityFailure('binding-mismatch', null, field, expectedHash, observedHash)),
    ),
  )

export interface PreparedCandidateDevelopmentMarketData {
  readonly witness: CandidateDevelopmentMarketDataWitness
  readonly sessions: readonly AlignedSession[]
  readonly sessionIndexByDate: ReadonlyMap<string, number>
}

export const compareCodeUnitStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

export const compareMarketBars = (left: DailyBar, right: DailyBar): number =>
  left.sessionDate === right.sessionDate
    ? compareCodeUnitStrings(left.symbol, right.symbol)
    : compareCodeUnitStrings(left.sessionDate, right.sessionDate)

export const prepareCandidateDevelopmentMarketData = (
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  officialSessions: CandidateDevelopmentPreflightInput['officialSessions'],
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<PreparedCandidateDevelopmentMarketData, CandidateDevelopmentCommandFailure> => {
  const { baseline, marketData } = evaluation
  const committed = verifiedSource.sourceManifest.marketData
  const { contentHash: observedContentHash, ...content } = marketData
  const expectedContentHash = canonicalEvidenceHash('marketData.content', content)
  if (Result.isFailure(expectedContentHash)) return Result.fail(expectedContentHash.failure)
  const scalarBindings = [
    ['marketData.committedContentHash', committed.boundedContentHash, observedContentHash],
    ['marketData.protocolContentHash', committed.boundedContentHash, strategyProtocol.marketData.contentHash],
    ['marketData.recomputedContentHash', expectedContentHash.success, observedContentHash],
    ['marketData.committedSnapshotId', committed.snapshotId, marketData.snapshotId],
    ['marketData.protocolSnapshotId', committed.snapshotId, strategyProtocol.marketData.snapshotId],
    ['marketData.manifestSnapshotId', baseline.inputManifest.finalizedSnapshot.snapshotId, marketData.snapshotId],
    [
      'marketData.finalizedSnapshotContentHash',
      committed.finalizedSnapshotContentHash,
      baseline.inputManifest.finalizedSnapshot.contentHash,
    ],
    ['marketData.committedInputManifestHash', committed.inputManifestHash, marketData.inputManifestHash],
    ['marketData.inputManifestHash', baseline.inputManifest.hash, marketData.inputManifestHash],
  ] as const
  for (const [field, expected, observed] of scalarBindings) {
    if (expected !== observed) {
      return Result.fail(markedEquityFailure('binding-mismatch', null, field, expected, observed))
    }
  }
  for (let index = 1; index < marketData.bars.length; index += 1) {
    const previous = marketData.bars[index - 1]
    const current = marketData.bars[index]
    if (compareMarketBars(previous, current) >= 0) {
      return Result.fail(
        markedEquityFailure('binding-mismatch', index, 'marketData.bars.order', 'strict session-date/symbol order', {
          previous: [previous.sessionDate, previous.symbol],
          current: [current.sessionDate, current.symbol],
        }),
      )
    }
  }
  const snapshot = baseline.inputManifest.finalizedSnapshot
  for (let index = 0; index < marketData.bars.length; index += 1) {
    const bar = marketData.bars[index]
    const expected = {
      source: snapshot.source,
      sourceFeed: snapshot.sourceFeed,
      adjustment: snapshot.adjustment,
      publicationSchemaVersion: snapshot.publicationSchemaVersion,
    }
    const observed = {
      source: bar.source,
      sourceFeed: bar.sourceFeed,
      adjustment: bar.adjustment,
      publicationSchemaVersion: bar.publicationSchemaVersion,
    }
    if (
      expected.source !== observed.source ||
      expected.sourceFeed !== observed.sourceFeed ||
      expected.adjustment !== observed.adjustment ||
      expected.publicationSchemaVersion !== observed.publicationSchemaVersion
    ) {
      return Result.fail(
        markedEquityFailure('binding-mismatch', index, 'marketData.bars.provenance', expected, observed),
      )
    }
  }
  return pipe(
    alignBars(marketData.bars, strategyProtocol.universe, baseline.inputManifest),
    Result.mapError((cause) =>
      markedEquityFailure('binding-mismatch', null, 'marketData.bars', 'manifest-bound aligned bars', null, cause),
    ),
    Result.flatMap((sessions) => {
      if (sessions.length !== officialSessions.length) {
        return Result.fail(
          markedEquityFailure(
            'binding-mismatch',
            null,
            'marketData.sessions.length',
            officialSessions.length,
            sessions.length,
          ),
        )
      }
      for (let index = 0; index < officialSessions.length; index += 1) {
        if (sessions[index]?.date !== officialSessions[index]) {
          return Result.fail(
            markedEquityFailure(
              'binding-mismatch',
              index,
              'marketData.sessions.sessionDate',
              officialSessions[index],
              sessions[index]?.date ?? null,
            ),
          )
        }
      }
      return Result.succeed({
        witness: marketData,
        sessions,
        sessionIndexByDate: new Map(sessions.map((session, index) => [session.date, index] as const)),
      })
    }),
  )
}

export const validateCandidateDevelopmentStrategyProtocol = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const protocolHash = canonicalEvidenceHash('strategyProtocol', strategyProtocol)
  if (Result.isFailure(protocolHash)) return Result.fail(protocolHash.failure)
  const expectedHash = report.comparisonSemantics.strategyProtocolHash
  if (protocolHash.success !== expectedHash || evaluation.baseline.protocolHash !== expectedHash) {
    return Result.fail(
      markedEquityFailure('binding-mismatch', null, 'strategyProtocolHash', expectedHash, {
        document: protocolHash.success,
        evaluation: evaluation.baseline.protocolHash,
      }),
    )
  }
  const scalarBindings = [
    ['initialCapitalMicros', strategyProtocol.initialCapitalMicros, evaluation.baseline.initialCapitalMicros],
  ] as const
  for (const [field, expected, observed] of scalarBindings) {
    if (expected !== observed) {
      return Result.fail(markedEquityFailure('binding-mismatch', null, `strategyProtocol.${field}`, expected, observed))
    }
  }
  const bindings = [
    [
      'strategyProtocol.universe',
      strategyProtocol.universe,
      evaluation.baseline.inputManifest.symbols.map(({ symbol }) => symbol),
    ],
    [
      'strategyProtocol.baselineExecutionModel',
      strategyProtocol.executionModel,
      evaluation.baseline.simulation.executionModel,
    ],
    [
      'strategyProtocol.stressedExecutionModel',
      strategyProtocol.executionModel,
      report.doubledCost.stressed.simulation.executionModel,
    ],
  ] as const
  for (const [field, expected, observed] of bindings) {
    const binding = requireCanonicalEvidenceEqual(field, expected, observed)
    if (Result.isFailure(binding)) return Result.fail(binding.failure)
  }
  return Result.succeed(undefined)
}

export const validateCandidateDevelopmentVerifiedSource = (
  evaluation: CandidateDevelopmentCommandEvaluation,
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const bindings = [
    ['verifiedSource.codeRevision', verifiedSource.sourceRevision, evaluation.baseline.codeRevision],
    ['verifiedSource.baselineRunId', verifiedSource.baselineRunId, evaluation.baseline.runId],
    ['verifiedSource.accountingRunId', verifiedSource.baselineRunId, evaluation.accounting.runId],
    ['verifiedSource.stressedRunId', verifiedSource.stressedRunId, evaluation.accounting.stressedRunId],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) {
      return Result.fail(markedEquityFailure('binding-mismatch', null, field, expected, observed))
    }
  }
  return Result.succeed(undefined)
}
