import { Effect, Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { makeStrategyProtocolHashResult } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import type { IntradayMarketDataService } from '../market-data'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import { Sha256Schema, strictParseOptions, UtcInstantSchema } from '../schemas'
import { activeStrategyBehaviorHash, activeStrategyName } from '../strategy'
import {
  decodeDefaultIntradayMomentumProtocol,
  hashIntradayMomentumProtocol,
} from '../strategy/intraday-momentum/protocol'
import { IntradayReplayFailure, IntradayReplayInputSchema, type IntradayReplayReport } from './model'
import { runIntradayReplay } from './program'

const StudyBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.archive-replay-study-input.v1'),
  experimentPlanHash: Sha256Schema,
  strategyProtocolHash: Sha256Schema,
  riskPolicyHash: Sha256Schema,
  sessionMode: Schema.Literal('independent-flat-start'),
  scenarios: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
      input: IntradayReplayInputSchema,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})

export const ArchiveReplayStudyInputSchema = StudyBase.check(
  Schema.makeFilter((study) => {
    if (new Set(study.scenarios.map(({ name }) => name)).size !== study.scenarios.length)
      return 'study scenario names must be unique'
    let expected: string | undefined
    for (const { input } of study.scenarios) {
      const material = canonicalHashV1Result({
        range: input.range,
        calendar: input.calendar,
        initialCapitalMicros: input.initialCapitalMicros,
        allocationCapitalMicros: input.allocationCapitalMicros,
      })
      if (Result.isFailure(material)) return 'study calendar and capital must be canonically hashable'
      expected ??= material.success
      if (expected !== material.success) return 'all scenarios must use the same calendar, range, and capital'
    }
    return undefined
  }),
)

export type ArchiveReplayStudyInput = typeof ArchiveReplayStudyInputSchema.Type

export interface ArchiveReplayStudySessionEvidence {
  readonly schemaVersion: 'bayn.archive-replay-study-session.v1'
  readonly inputHash: string
  readonly experimentPlanHash: string
  readonly scenarioName: string
  readonly replay: IntradayReplayReport
}

export interface ArchiveReplayStudyScenario {
  readonly name: string
  /** Every calendar day has its own fixed-capital research experiment, including failed days. */
  readonly replays: readonly IntradayReplayReport[]
  readonly totals: {
    readonly completedSessionCount: number
    readonly incompleteSessionCount: number
    readonly executionSessionCount: number
    /** Counts among completed independent experiments only, even if other dates are incomplete. */
    readonly winningSessionCount: number
    /** Counts among completed independent experiments only; never an all-calendar win/loss rate. */
    readonly losingSessionCount: number
    /** Null unless every declared session completed; never sum a favorable subset. */
    readonly independentSessionNetPnlMicros: string | null
  }
}

export interface ArchiveReplayStudyReport {
  readonly schemaVersion: 'bayn.archive-replay-study-report.v1'
  readonly evidenceKind: 'COUNTERFACTUAL_RESEARCH'
  readonly qualification: 'NOT_QUALIFIED'
  readonly evaluatedAt: string
  readonly input: ArchiveReplayStudyInput
  readonly inputHash: string
  readonly scenarios: readonly ArchiveReplayStudyScenario[]
  readonly limitations: readonly string[]
  readonly reportHash: string
}

const fail = (operation: IntradayReplayFailure['operation'], message: string, cause?: unknown) =>
  new IntradayReplayFailure({ operation, message, ...(cause === undefined ? {} : { cause }) })

const hash = (value: unknown) =>
  Effect.fromResult(canonicalHashV1Result(value)).pipe(
    Effect.mapError((cause) => fail('report', 'archive study material is not canonically hashable', cause)),
  )

const verifyStudyIdentity = (input: ArchiveReplayStudyInput) =>
  Effect.gen(function* () {
    const protocol = yield* Effect.fromResult(decodeDefaultIntradayMomentumProtocol()).pipe(
      Effect.mapError((cause) => fail('strategy', 'active archive study protocol is invalid', cause)),
    )
    const parameterHash = yield* Effect.fromResult(hashIntradayMomentumProtocol(protocol)).pipe(
      Effect.mapError((cause) => fail('strategy', 'archive study parameter identity failed', cause)),
    )
    const strategyHash = yield* Effect.fromResult(
      makeStrategyProtocolHashResult({
        name: activeStrategyName,
        behaviorHash: activeStrategyBehaviorHash,
        parameterHash,
        parameterSchemaVersion: protocol.schemaVersion,
      }),
    ).pipe(Effect.mapError((cause) => fail('strategy', 'archive study strategy identity failed', cause)))
    const policy = yield* loadQuoteBoundExecutionRiskPolicy('build-contract', protocol.universe).pipe(
      Effect.mapError((cause) => fail('strategy', 'archive study risk policy failed', cause)),
    )
    if (strategyHash !== input.strategyProtocolHash || (yield* hash(policy)) !== input.riskPolicyHash)
      return yield* fail('strategy', 'archive study frozen strategy or risk identity does not match the implementation')
  })

export const runArchiveReplayStudy = (
  input: ArchiveReplayStudyInput,
  marketData: IntradayMarketDataService,
  now: string,
  onSessionComplete: (evidence: ArchiveReplayStudySessionEvidence) => Effect.Effect<void, IntradayReplayFailure> = () =>
    Effect.void,
): Effect.Effect<ArchiveReplayStudyReport, IntradayReplayFailure> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(
      ArchiveReplayStudyInputSchema,
      strictParseOptions,
    )(input).pipe(Effect.mapError((cause) => fail('input', 'invalid archive replay study input', cause)))
    yield* Schema.decodeUnknownEffect(
      UtcInstantSchema,
      strictParseOptions,
    )(now).pipe(Effect.mapError((cause) => fail('input', 'archive study now must be a canonical UTC instant', cause)))
    yield* verifyStudyIdentity(decoded)
    const inputHash = yield* hash(decoded)
    // Validate every scenario before the first archive read, including duplicate and unfinished sessions.
    for (const scenario of decoded.scenarios) {
      const calendar = yield* Effect.fromResult(
        normalizeMarketCalendarResult(scenario.input.calendar, scenario.input.range),
      ).pipe(Effect.mapError((cause) => fail('calendar', 'archive study calendar is invalid', cause)))
      if (calendar.sessions.length === 0 || calendar.sessions.some((session) => session.closeAt >= now))
        return yield* fail('calendar', 'archive study requires a non-empty calendar of finalized sessions')
    }

    const scenarios: ArchiveReplayStudyScenario[] = []
    for (const scenario of decoded.scenarios) {
      const replays: IntradayReplayReport[] = []
      const sessions = [...scenario.input.calendar].sort((left, right) => left.date.localeCompare(right.date))
      for (const session of sessions) {
        const replay = yield* runIntradayReplay(
          {
            ...scenario.input,
            range: { start: session.date, end: session.date },
            calendar: [session],
          },
          marketData,
          now,
        )
        replays.push(replay)
        yield* onSessionComplete({
          schemaVersion: 'bayn.archive-replay-study-session.v1',
          inputHash,
          experimentPlanHash: decoded.experimentPlanHash,
          scenarioName: scenario.name,
          replay,
        })
        yield* Effect.logInfo('archive replay study session completed', {
          scenario: scenario.name,
          date: session.date,
          reportHash: replay.reportHash,
          ...replay.totals,
        })
      }
      const completedSessionCount = replays.reduce((count, replay) => count + replay.totals.completedSessionCount, 0)
      const incompleteSessionCount = replays.reduce((count, replay) => count + replay.totals.incompleteSessionCount, 0)
      const completed = replays.flatMap((replay) => replay.sessions).filter((session) => session.status === 'COMPLETE')
      const completedPnl: bigint[] = []
      for (const session of completed) {
        if (session.netRealizedPnlAfterCostsMicros === null)
          return yield* fail('accounting', 'a completed archive study session omitted net realized P&L')
        completedPnl.push(BigInt(session.netRealizedPnlAfterCostsMicros))
      }
      scenarios.push({
        name: scenario.name,
        replays,
        totals: {
          completedSessionCount,
          incompleteSessionCount,
          executionSessionCount: replays.reduce((count, replay) => count + replay.totals.executionSessionCount, 0),
          winningSessionCount: completedPnl.filter((pnl) => pnl > 0n).length,
          losingSessionCount: completedPnl.filter((pnl) => pnl < 0n).length,
          independentSessionNetPnlMicros:
            incompleteSessionCount === 0 ? completedPnl.reduce((sum, pnl) => sum + pnl, 0n).toString() : null,
        },
      })
    }
    const material: Omit<ArchiveReplayStudyReport, 'reportHash'> = {
      schemaVersion: 'bayn.archive-replay-study-report.v1',
      evidenceKind: 'COUNTERFACTUAL_RESEARCH',
      qualification: 'NOT_QUALIFIED',
      evaluatedAt: now,
      input: decoded,
      inputHash,
      scenarios,
      limitations: [
        'each date is an independent flat-start experiment at identical initial capital; this is not a continuous portfolio',
        'an incomplete date never skips later experiments and prevents aggregate P&L for its entire declared scenario',
        'all declared scenarios and calendar dates are retained; a plan hash binds the declaration but does not prove it was preregistered',
        'historical results do not establish future profitability or grant broker or capital authority',
        'each nested replay retains its exact archive manifests, execution assumptions, and limitations',
      ],
    }
    return { ...material, reportHash: yield* hash(material) }
  })
