import { Result, Schema } from 'effect'

import type { MarketCalendarObservation } from '../../broker/alpaca'
import { normalizeMarketCalendarResult } from '../../broker/alpaca/normalizers'
import { makeExecutionCalendarObservation } from '../../cycle'
import { canonicalHashV1Result } from '../../hash'
import type { IntradaySnapshotQuery, IntradaySnapshotRequest } from '../../market-data'
import type { SignalSessionRow } from '../../market-data/rows'
import {
  IsoDateSchema,
  Sha256Schema,
  SourceRevisionSchema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'
import { utcInstantFromEpochMillis } from '../../time'
import type { IsoDate } from '../../types'
import { openingDriveBehaviorHash } from './decision'
import {
  OpeningDriveQualificationFailure,
  type OpeningDriveQualificationBinding,
  type OpeningDriveQualificationCalendar,
  type OpeningDriveQualificationPolicy,
} from './qualification-model'
import { defaultOpeningDriveQualificationPolicy, hashOpeningDriveQualificationPolicy } from './qualification-policy'
import { hashOpeningDriveReplayCostModel } from './qualification-replay'
import {
  hashOpeningDriveReplayVersionGraph,
  makeOpeningDriveReplayVersionSession,
  type OpeningDriveReplayVersionSession,
} from './qualification-version'
import { hashOpeningDriveProtocol, type OpeningDriveProtocol } from './protocol'

export const openingDriveIntradayArchiveTopics = Object.freeze({
  bars: 'torghut.bars.1m.v1',
  quotes: 'torghut.quotes.v1',
  trades: 'torghut.trades.v1',
})

export interface OpeningDriveQualificationSessionPlan {
  readonly sessionDate: IsoDate
  readonly openingQuery: IntradaySnapshotQuery
  readonly exitQuery: IntradaySnapshotQuery
}

export interface OpeningDriveQualificationVersionedSession {
  readonly sessionDate: string
  readonly openingRequest: IntradaySnapshotRequest
  readonly exitRequest: IntradaySnapshotRequest
  readonly version: OpeningDriveReplayVersionSession
}

export interface OpeningDriveQualificationLock {
  readonly schemaVersion: 'bayn.opening-drive.qualification-lock.v1'
  readonly lockId: string
  /** Identity of the exact candidate evidence excluding sequential prior-trial lineage. */
  readonly candidateKey: string
  readonly binding: OpeningDriveQualificationBinding
  readonly calendar: OpeningDriveQualificationCalendar
}

const OpeningDriveQualificationBindingSchema = Schema.Struct({
  sourceRevision: SourceRevisionSchema,
  strategyBehaviorHash: Sha256Schema,
  protocolHash: Sha256Schema,
  policyHash: Sha256Schema,
  costModelHash: Sha256Schema,
  evaluationCalendarHash: Sha256Schema,
  replayVersionGraphHash: Sha256Schema,
  priorTrialReceiptHashes: Schema.Array(Sha256Schema),
})

const OpeningDriveQualificationCalendarSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.opening-drive.qualification-calendar.v1'),
  source: Schema.Literal('signal.exchange_sessions_v1'),
  calendarVersion: StrictNonEmptyStringSchema,
  firstSession: IsoDateSchema,
  lastSession: IsoDateSchema,
  finalizedAt: UtcInstantSchema,
  sessions: Schema.Array(
    Schema.Struct({
      sessionDate: IsoDateSchema,
      openAt: UtcInstantSchema,
      closeAt: UtcInstantSchema,
      calendarHash: Sha256Schema,
    }),
  ).check(Schema.isMinLength(1)),
  contentHash: Sha256Schema,
})

const OpeningDriveQualificationLockSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.opening-drive.qualification-lock.v1'),
  lockId: Sha256Schema,
  candidateKey: Sha256Schema,
  binding: OpeningDriveQualificationBindingSchema,
  calendar: OpeningDriveQualificationCalendarSchema,
})

const decodeQualificationLockResult = Schema.decodeUnknownResult(
  OpeningDriveQualificationLockSchema,
  strictParseOptions,
)

const failure = (message: string, cause?: unknown): OpeningDriveQualificationFailure =>
  new OpeningDriveQualificationFailure({ reason: 'input', message, cause })

const hashFailure = (message: string, cause?: unknown): OpeningDriveQualificationFailure =>
  new OpeningDriveQualificationFailure({ reason: 'canonicalization', message, cause })

export const decodeOpeningDriveQualificationLock = (
  input: unknown,
): Result.Result<OpeningDriveQualificationLock, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    const decoded = yield* Result.mapError(decodeQualificationLockResult(input), (cause) =>
      failure('Stored opening-drive qualification lock failed schema validation', cause),
    )
    const { contentHash, ...calendarMaterial } = decoded.calendar
    const expectedCalendarHash = yield* Result.mapError(canonicalHashV1Result(calendarMaterial), (cause) =>
      hashFailure('Stored opening-drive qualification calendar is not canonically hashable', cause),
    )
    if (
      expectedCalendarHash !== contentHash ||
      decoded.binding.evaluationCalendarHash !== contentHash ||
      decoded.calendar.firstSession !== decoded.calendar.sessions[0]?.sessionDate ||
      decoded.calendar.lastSession !== decoded.calendar.sessions.at(-1)?.sessionDate
    ) {
      return yield* Result.fail(failure('Stored opening-drive qualification calendar identity is inconsistent'))
    }
    const candidateKey = yield* Result.mapError(
      canonicalHashV1Result({
        schemaVersion: 'bayn.opening-drive.qualification-candidate.v1',
        sourceRevision: decoded.binding.sourceRevision,
        strategyBehaviorHash: decoded.binding.strategyBehaviorHash,
        protocolHash: decoded.binding.protocolHash,
        policyHash: decoded.binding.policyHash,
        costModelHash: decoded.binding.costModelHash,
        evaluationCalendarHash: decoded.binding.evaluationCalendarHash,
        replayVersionGraphHash: decoded.binding.replayVersionGraphHash,
      }),
      (cause) => hashFailure('Stored opening-drive qualification candidate is not canonically hashable', cause),
    )
    const lockId = yield* Result.mapError(
      canonicalHashV1Result({
        schemaVersion: decoded.schemaVersion,
        candidateKey,
        binding: decoded.binding,
      }),
      (cause) => hashFailure('Stored opening-drive qualification lock is not canonically hashable', cause),
    )
    if (candidateKey !== decoded.candidateKey || lockId !== decoded.lockId) {
      return yield* Result.fail(failure('Stored opening-drive qualification lock identity does not match its content'))
    }
    return Object.freeze({
      ...decoded,
      binding: Object.freeze({
        ...decoded.binding,
        priorTrialReceiptHashes: Object.freeze([...decoded.binding.priorTrialReceiptHashes]),
      }),
      calendar: Object.freeze({
        ...decoded.calendar,
        sessions: Object.freeze(decoded.calendar.sessions.map((session) => Object.freeze({ ...session }))),
      }),
    })
  })

const canonicalFinalizedAt = (value: string): string | undefined => {
  const candidate = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const epoch = Date.parse(candidate)
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : undefined
}

const normalizedCalendar = (
  row: SignalSessionRow,
): Result.Result<MarketCalendarObservation, OpeningDriveQualificationFailure> =>
  Result.mapError(
    normalizeMarketCalendarResult([{ date: row.session_date, open: row.open_time, close: row.close_time }], {
      start: row.session_date,
      end: row.session_date,
    }),
    (cause) => failure('Signal exchange session cannot form a canonical intraday calendar observation', cause),
  )

const query = (
  protocol: OpeningDriveProtocol,
  calendar: MarketCalendarObservation,
  sessionDate: IsoDate,
  rangeStartAt: string,
  rangeEndAt: string,
  observedAt: string,
  minimumWatermarkLagMs: number,
): IntradaySnapshotQuery => ({
  sessionDate,
  calendar,
  rangeStartAt,
  rangeEndAt,
  observedAt,
  universeId: protocol.universeId,
  universeSymbolHash: protocol.universeSymbolHash,
  universe: protocol.universe,
  feed: protocol.feed,
  delayClass: protocol.delayClass,
  sourceTopics: openingDriveIntradayArchiveTopics,
  maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
  minimumWatermarkLagMs,
})

export const prepareOpeningDriveQualificationCalendar = (input: {
  readonly sessions: readonly SignalSessionRow[]
  readonly finalizedAt: string
  readonly protocol: OpeningDriveProtocol
}): Result.Result<
  {
    readonly calendar: OpeningDriveQualificationCalendar
    readonly sessions: readonly OpeningDriveQualificationSessionPlan[]
  },
  OpeningDriveQualificationFailure
> =>
  Result.gen(function* () {
    if (input.sessions.length === 0) return yield* Result.fail(failure('Opening-drive qualification calendar is empty'))
    const finalizedAt = canonicalFinalizedAt(input.finalizedAt)
    if (finalizedAt === undefined)
      return yield* Result.fail(failure('Qualification calendar finalization time is invalid'))
    const calendarVersion = input.sessions[0]?.calendar_version
    if (
      calendarVersion === undefined ||
      input.sessions.some((session, index) =>
        index > 0
          ? session.calendar_version !== calendarVersion ||
            session.session_date <= (input.sessions[index - 1]?.session_date ?? '')
          : session.calendar_version !== calendarVersion,
      )
    ) {
      return yield* Result.fail(
        failure('Qualification Signal sessions must be strictly ordered under one calendar version'),
      )
    }

    const bindings = []
    const plans: OpeningDriveQualificationSessionPlan[] = []
    for (const row of input.sessions) {
      const calendar = yield* normalizedCalendar(row)
      const selected = calendar.sessions[0]
      if (selected === undefined)
        return yield* Result.fail(failure('Normalized qualification calendar omitted its session'))
      const executionCalendar = yield* Result.mapError(
        makeExecutionCalendarObservation({
          schemaVersion: calendar.schemaVersion,
          source: calendar.source,
          ...selected,
        }),
        (cause) => failure('Qualification session cannot form an execution-calendar binding', cause),
      )
      bindings.push(
        Object.freeze({
          sessionDate: row.session_date,
          openAt: selected.openAt,
          closeAt: selected.closeAt,
          calendarHash: executionCalendar.executionCalendarHash,
        }),
      )

      const openingStart = Date.parse(selected.openAt)
      const openingEnd = openingStart + input.protocol.openingRangeMinutes * 60_000
      const openingObserved = openingEnd + input.protocol.decisionDelaySeconds * 1_000
      const exitEnd = Date.parse(selected.closeAt) - input.protocol.flattenBeforeCloseMinutes * 60_000
      const exitStart = exitEnd - 60_000
      const exitObserved = exitEnd + 1_000
      plans.push(
        Object.freeze({
          sessionDate: row.session_date,
          openingQuery: query(
            input.protocol,
            calendar,
            row.session_date,
            selected.openAt,
            utcInstantFromEpochMillis(openingEnd),
            utcInstantFromEpochMillis(openingObserved),
            input.protocol.decisionDelaySeconds * 1_000,
          ),
          exitQuery: query(
            input.protocol,
            calendar,
            row.session_date,
            utcInstantFromEpochMillis(exitStart),
            utcInstantFromEpochMillis(exitEnd),
            utcInstantFromEpochMillis(exitObserved),
            0,
          ),
        }),
      )
    }
    const first = bindings[0]
    const last = bindings.at(-1)
    if (first === undefined || last === undefined)
      return yield* Result.fail(failure('Qualification calendar has no bounds'))
    const calendarMaterial = Object.freeze({
      schemaVersion: 'bayn.opening-drive.qualification-calendar.v1' as const,
      source: 'signal.exchange_sessions_v1' as const,
      calendarVersion,
      firstSession: first.sessionDate,
      lastSession: last.sessionDate,
      finalizedAt,
      sessions: Object.freeze(bindings),
    })
    const contentHash = yield* Result.mapError(canonicalHashV1Result(calendarMaterial), (cause) =>
      hashFailure('Qualification calendar is not canonically hashable', cause),
    )
    return Object.freeze({
      calendar: Object.freeze({ ...calendarMaterial, contentHash }),
      sessions: Object.freeze(plans),
    })
  })

export const bindOpeningDriveQualificationVersions = (
  sessions: readonly OpeningDriveQualificationVersionedSession[],
  input: {
    readonly sourceRevision: string
    readonly protocol: OpeningDriveProtocol
    readonly calendar: OpeningDriveQualificationCalendar
    readonly priorTrialReceiptHashes: readonly string[]
    readonly policy?: OpeningDriveQualificationPolicy
  },
): Result.Result<OpeningDriveQualificationLock, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    const policy = input.policy ?? defaultOpeningDriveQualificationPolicy
    const versionGraphHash = yield* hashOpeningDriveReplayVersionGraph(sessions.map(({ version }) => version))
    const hashes = yield* Result.all({
      protocolHash: Result.mapError(hashOpeningDriveProtocol(input.protocol), (cause) =>
        hashFailure('Opening-drive protocol is not canonically hashable', cause),
      ),
      policyHash: hashOpeningDriveQualificationPolicy(policy),
      costModelHash: hashOpeningDriveReplayCostModel(),
    })
    const binding: OpeningDriveQualificationBinding = Object.freeze({
      sourceRevision: input.sourceRevision,
      strategyBehaviorHash: openingDriveBehaviorHash,
      protocolHash: hashes.protocolHash,
      policyHash: hashes.policyHash,
      costModelHash: hashes.costModelHash,
      evaluationCalendarHash: input.calendar.contentHash,
      replayVersionGraphHash: versionGraphHash,
      priorTrialReceiptHashes: Object.freeze([...input.priorTrialReceiptHashes].sort()),
    })
    const candidateKey = yield* Result.mapError(
      canonicalHashV1Result({
        schemaVersion: 'bayn.opening-drive.qualification-candidate.v1',
        sourceRevision: binding.sourceRevision,
        strategyBehaviorHash: binding.strategyBehaviorHash,
        protocolHash: binding.protocolHash,
        policyHash: binding.policyHash,
        costModelHash: binding.costModelHash,
        evaluationCalendarHash: binding.evaluationCalendarHash,
        replayVersionGraphHash: binding.replayVersionGraphHash,
      }),
      (cause) => hashFailure('Opening-drive qualification candidate is not canonically hashable', cause),
    )
    const material = Object.freeze({
      schemaVersion: 'bayn.opening-drive.qualification-lock.v1' as const,
      candidateKey,
      binding,
    })
    const lockId = yield* Result.mapError(canonicalHashV1Result(material), (cause) =>
      hashFailure('Opening-drive qualification lock is not canonically hashable', cause),
    )
    return Object.freeze({ ...material, lockId, calendar: input.calendar })
  })

export const versionOpeningDriveQualificationSession = (
  plan: OpeningDriveQualificationSessionPlan,
  openingRequest: IntradaySnapshotRequest,
  exitRequest: IntradaySnapshotRequest,
): Result.Result<OpeningDriveQualificationVersionedSession, OpeningDriveQualificationFailure> =>
  Result.map(makeOpeningDriveReplayVersionSession(plan.sessionDate, openingRequest, exitRequest), (version) =>
    Object.freeze({ sessionDate: plan.sessionDate, openingRequest, exitRequest, version }),
  )
