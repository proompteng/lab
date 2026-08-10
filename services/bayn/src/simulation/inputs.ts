import { Chunk, Option, pipe, Result } from 'effect'

import { makeRunIdentityResult, makeStrategyProtocolHashResult, type RuntimeProvenance } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import { ContractVersion, type DailyBar, type InputManifest, type IsoDate, type Protocol } from '../types'
import type { AlignedSession, EvaluationIdentity, EvaluationWindow, SimulationFailure } from './model'
import { optionalRecordValue } from './record'
import { Pipeable } from '../pipeable'

const fail = <A = never>(failure: SimulationFailure): Result.Result<A, SimulationFailure> => Result.fail(failure)

type SessionOperation = Extract<SimulationFailure, { readonly _tag: 'MissingSession' }>['operation']
type RecordOperation = Extract<SimulationFailure, { readonly _tag: 'MissingRecordValue' }>['operation']
type CanonicalOperation = Extract<SimulationFailure, { readonly _tag: 'CanonicalizationFailed' }>['operation']

interface GroupedBars {
  readonly completed: Chunk.Chunk<Chunk.Chunk<DailyBar>>
  readonly current: Chunk.Chunk<DailyBar>
  readonly currentDate: IsoDate | null
}

const compareBars = (left: DailyBar, right: DailyBar): number =>
  left.sessionDate < right.sessionDate
    ? -1
    : left.sessionDate > right.sessionDate
      ? 1
      : left.symbol < right.symbol
        ? -1
        : left.symbol > right.symbol
          ? 1
          : 0

const groupedBars = (bars: readonly DailyBar[]): readonly (readonly DailyBar[])[] => {
  const grouped = bars.toSorted(compareBars).reduce<GroupedBars>(
    (state, bar) =>
      state.currentDate === null || state.currentDate === bar.sessionDate
        ? {
            ...state,
            current: Chunk.append(state.current, bar),
            currentDate: bar.sessionDate,
          }
        : {
            completed: Chunk.append(state.completed, state.current),
            current: Chunk.of(bar),
            currentDate: bar.sessionDate,
          },
    {
      completed: Chunk.empty(),
      current: Chunk.empty(),
      currentDate: null,
    },
  )
  const groups = grouped.currentDate === null ? grouped.completed : Chunk.append(grouped.completed, grouped.current)
  return Chunk.toReadonlyArray(groups).map(Chunk.toReadonlyArray)
}

const canonicalHashResultDataFirst = (
  operation: CanonicalOperation,
  material: unknown,
): Result.Result<string, SimulationFailure> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError((cause): SimulationFailure => ({ _tag: 'CanonicalizationFailed', operation, cause })),
  )

export const canonicalHashResult = Pipeable.dual(2, canonicalHashResultDataFirst)

const requiredSessionDataFirst = (
  sessions: readonly AlignedSession[],
  index: number,
  operation: SessionOperation,
): Result.Result<AlignedSession, SimulationFailure> => {
  const session = sessions.at(index)
  return session === undefined
    ? fail({ _tag: 'MissingSession', operation, index, sessionCount: sessions.length })
    : Result.succeed(session)
}

export const requiredSession = Pipeable.dual(3, requiredSessionDataFirst)

const requiredRecordValueDataFirst = <A>(
  values: Readonly<Record<string, A>>,
  key: string,
  operation: RecordOperation,
  context: string,
): Result.Result<A, SimulationFailure> =>
  pipe(
    optionalRecordValue(values, key, operation, context),
    Result.flatMap(
      Option.match({
        onNone: () => fail({ _tag: 'MissingRecordValue', operation, key, context }),
        onSome: Result.succeed,
      }),
    ),
  )

export const requiredRecordValue = Pipeable.generic<
  <A>(
    key: string,
    operation: RecordOperation,
    context: string,
  ) => (values: Readonly<Record<string, A>>) => Result.Result<A, SimulationFailure>,
  typeof requiredRecordValueDataFirst
>(4, requiredRecordValueDataFirst)

const buildAlignedSession = (
  bars: readonly DailyBar[],
  universe: readonly string[],
): Result.Result<AlignedSession, SimulationFailure> => {
  const first = bars.at(0)
  if (first === undefined) {
    return fail({
      _tag: 'MissingSession',
      operation: 'planning',
      index: 0,
      sessionCount: 0,
    })
  }
  const observedSymbols = bars.map((bar) => bar.symbol)
  if (
    observedSymbols.length !== universe.length ||
    observedSymbols.some((symbol, index) => symbol !== universe.at(index))
  ) {
    return fail({
      _tag: 'IncompleteSession',
      sessionDate: first.sessionDate,
      expectedSymbols: universe,
      observedSymbols,
    })
  }
  return Result.succeed({
    date: first.sessionDate,
    bars: Object.fromEntries(bars.map((bar) => [bar.symbol, bar])),
  })
}

const alignBarsDataFirst = (
  bars: readonly DailyBar[],
  universe: readonly string[],
  inputManifest: InputManifest,
): Result.Result<readonly AlignedSession[], SimulationFailure> => {
  if (bars.length !== inputManifest.rowCount) {
    return fail({
      _tag: 'ManifestRowCountMismatch',
      expected: inputManifest.rowCount,
      observed: bars.length,
    })
  }
  const universeSet = new Set(universe)
  const unexpected = bars.find((bar) => !universeSet.has(bar.symbol))
  if (unexpected !== undefined) {
    return fail({
      _tag: 'UnexpectedBarSymbol',
      symbol: unexpected.symbol,
      universe,
    })
  }
  const groups = groupedBars(bars)
  const duplicate = groups
    .flatMap((group) =>
      group.slice(1).flatMap((bar, index) => {
        const previous = group.at(index)
        return previous === undefined ? [] : [{ current: bar, previous }]
      }),
    )
    .find(({ current, previous }) => current.symbol === previous.symbol)
  if (duplicate !== undefined) {
    return fail({
      _tag: 'DuplicateBar',
      symbol: duplicate.current.symbol,
      sessionDate: duplicate.current.sessionDate,
    })
  }
  if (groups.length !== inputManifest.sessionCount) {
    return fail({
      _tag: 'ManifestSessionCountMismatch',
      expected: inputManifest.sessionCount,
      observed: groups.length,
    })
  }
  const sessions = Result.all(groups.map((group) => buildAlignedSession(group, universe)))
  if (Result.isFailure(sessions)) return sessions
  const first = sessions.success.at(0)?.date ?? null
  const last = sessions.success.at(-1)?.date ?? null
  if (first !== inputManifest.firstSession || last !== inputManifest.lastSession) {
    return fail({
      _tag: 'ManifestSessionBoundsMismatch',
      expectedFirst: inputManifest.firstSession,
      observedFirst: first,
      expectedLast: inputManifest.lastSession,
      observedLast: last,
    })
  }
  return sessions
}

export const alignBars = Pipeable.dual(3, alignBarsDataFirst)

const isMonthEndDataFirst = (
  sessionDates: readonly IsoDate[],
  index: number,
): Result.Result<boolean, SimulationFailure> => {
  const current = sessionDates.at(index)
  if (current === undefined) {
    return fail({
      _tag: 'MissingSession',
      operation: 'qualification-window',
      index,
      sessionCount: sessionDates.length,
    })
  }
  const next = sessionDates.at(index + 1)
  return Result.succeed(next !== undefined && current.slice(0, 7) !== next.slice(0, 7))
}

export const isMonthEnd = Pipeable.dual(2, isMonthEndDataFirst)

const qualificationCalendarFailure = (
  sessionDates: readonly IsoDate[],
  inputManifest: InputManifest,
): SimulationFailure => ({
  _tag: 'QualificationCalendarMismatch',
  expectedCount: inputManifest.sessionCount,
  observedCount: sessionDates.length,
  expectedFirst: inputManifest.firstSession,
  observedFirst: sessionDates.at(0) ?? null,
  expectedLast: inputManifest.lastSession,
  observedLast: sessionDates.at(-1) ?? null,
})

const selectEvaluationWindowDataFirst = (
  sessionDates: readonly IsoDate[],
  inputManifest: InputManifest,
  requiredHistorySessions: number,
  minimumObservations: number,
): Result.Result<EvaluationWindow, SimulationFailure> => {
  if (!Number.isSafeInteger(requiredHistorySessions) || requiredHistorySessions < 0) {
    return fail({
      _tag: 'InvalidWindowRequirement',
      field: 'requiredHistorySessions',
      value: requiredHistorySessions,
    })
  }
  if (!Number.isSafeInteger(minimumObservations) || minimumObservations < 0) {
    return fail({
      _tag: 'InvalidWindowRequirement',
      field: 'minimumObservations',
      value: minimumObservations,
    })
  }
  if (
    sessionDates.length !== inputManifest.sessionCount ||
    sessionDates.at(0) !== inputManifest.firstSession ||
    sessionDates.at(-1) !== inputManifest.lastSession ||
    sessionDates.some((date, index) => {
      if (index === 0) return false
      const previous = sessionDates.at(index - 1)
      return previous !== undefined && date <= previous
    })
  ) {
    return fail(qualificationCalendarFailure(sessionDates, inputManifest))
  }
  const candidates = Result.all(
    sessionDates.map((_, index) =>
      pipe(
        isMonthEnd(sessionDates, index),
        Result.map((monthEnd) => ({ index, monthEnd })),
      ),
    ),
  )
  if (Result.isFailure(candidates)) return fail(candidates.failure)
  const signalIndices = candidates.success
    .filter(({ index, monthEnd }) => {
      const historyStart = sessionDates.at(index - requiredHistorySessions)
      const executionDate = sessionDates.at(index + 1)
      return (
        monthEnd &&
        index >= requiredHistorySessions &&
        index < sessionDates.length - 1 &&
        historyStart !== undefined &&
        executionDate !== undefined &&
        historyStart >= inputManifest.bounds.lookbackStart &&
        executionDate >= inputManifest.bounds.evaluationStart &&
        executionDate <= inputManifest.bounds.evaluationEnd
      )
    })
    .map(({ index }) => index)
  const firstSignalIndex = signalIndices.at(0)
  if (firstSignalIndex === undefined) return fail({ _tag: 'NoEligibleMonthEndSignal' })
  const startIndex = firstSignalIndex + 1
  const evaluationEndExclusive = sessionDates.findIndex((date) => date > inputManifest.bounds.evaluationEnd)
  const boundedEnd = evaluationEndExclusive === -1 ? sessionDates.length : evaluationEndExclusive
  const selectedSessionCount = boundedEnd - startIndex
  if (selectedSessionCount < minimumObservations) {
    return fail({
      _tag: 'InsufficientComparableObservations',
      observed: selectedSessionCount,
      required: minimumObservations,
    })
  }
  return Result.succeed({ signalIndices, startIndex, evaluationEndExclusive: boundedEnd })
}

export const selectEvaluationWindow = Pipeable.dual(4, selectEvaluationWindowDataFirst)

const makeEvaluationIdentityDataFirst = (
  inputManifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
  expectedStrategyName = 'risk-balanced-trend',
): Result.Result<EvaluationIdentity, SimulationFailure> => {
  if (provenance.strategy.name !== expectedStrategyName) {
    return fail({
      _tag: 'RuntimeStrategyMismatch',
      observed: provenance.strategy.name,
      expected: expectedStrategyName,
    })
  }
  if (provenance.strategy.parameterSchemaVersion !== protocol.schemaVersion) {
    return fail({
      _tag: 'RuntimeParameterSchemaMismatch',
      observed: provenance.strategy.parameterSchemaVersion,
      expected: protocol.schemaVersion,
    })
  }
  return pipe(
    canonicalHashResult('parameter', protocol),
    Result.flatMap((expectedParameterHash) => {
      if (provenance.strategy.parameterHash !== expectedParameterHash) {
        return fail({
          _tag: 'RuntimeParameterHashMismatch',
          observed: provenance.strategy.parameterHash,
          expected: expectedParameterHash,
        })
      }
      const { hash: inputManifestHash, ...inputManifestMaterial } = inputManifest
      return pipe(
        canonicalHashResult('input-manifest', inputManifestMaterial),
        Result.flatMap((expectedManifestHash) => {
          if (inputManifestHash !== expectedManifestHash) {
            return fail({
              _tag: 'InputManifestHashMismatch',
              observed: inputManifestHash,
              expected: expectedManifestHash,
            })
          }
          return pipe(
            Result.all({
              runId: pipe(
                makeRunIdentityResult({
                  schemaVersion: ContractVersion.RunIdentity,
                  sourceRevision: provenance.sourceRevision,
                  image: provenance.image,
                  strategy: {
                    name: provenance.strategy.name,
                    behaviorHash: provenance.strategy.behaviorHash,
                    parameters: protocol,
                  },
                  finalizedSnapshot: inputManifest.finalizedSnapshot,
                  calendarVersion: inputManifest.finalizedSnapshot.calendarVersion,
                  bounds: inputManifest.bounds,
                }),
                Result.map((identity) => identity.runId),
                Result.mapError(
                  (cause): SimulationFailure => ({
                    _tag: 'ContractConstructionFailed',
                    operation: 'run-identity',
                    cause,
                  }),
                ),
              ),
              protocolHash: pipe(
                makeStrategyProtocolHashResult(provenance.strategy),
                Result.mapError(
                  (cause): SimulationFailure => ({
                    _tag: 'ContractConstructionFailed',
                    operation: 'strategy-protocol',
                    cause,
                  }),
                ),
              ),
            }),
            Result.map(({ runId, protocolHash }) => ({ runId, protocolHash })),
          )
        }),
      )
    }),
  )
}

export const makeEvaluationIdentity = Pipeable.by<
  (
    protocol: Protocol,
    provenance: RuntimeProvenance,
    expectedStrategyName?: string,
  ) => (inputManifest: InputManifest) => ReturnType<typeof makeEvaluationIdentityDataFirst>,
  typeof makeEvaluationIdentityDataFirst
>(
  (arguments_) =>
    typeof arguments_[0] === 'object' &&
    arguments_[0] !== null &&
    arguments_[0].schemaVersion === 'bayn.input-manifest.v3',
  makeEvaluationIdentityDataFirst,
)
