import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { openingDriveBehaviorHash } from './decision'
import {
  OpeningDriveQualificationFailure,
  type OpeningDriveQualificationBinding,
  type OpeningDriveQualificationCalendar,
  type OpeningDriveQualificationPolicy,
  type OpeningDriveQualificationRun,
  type OpeningDriveReplaySessionInput,
} from './qualification-model'
import {
  defaultOpeningDriveQualificationPolicy,
  hashOpeningDriveQualificationPolicy,
  validateOpeningDriveQualificationPolicy,
} from './qualification-policy'
import { analyzeOpeningDriveQualification } from './qualification-analysis'
import { hashOpeningDriveReplayCostModel, replayOpeningDriveSession } from './qualification-replay'
import { hashOpeningDriveReplayVersionGraphFromInputs } from './qualification-version'
import { hashOpeningDriveProtocol, type OpeningDriveProtocol } from './protocol'

const canonicalInstant = (value: string): boolean => {
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
}

const validateQualificationCalendar = (
  calendar: OpeningDriveQualificationCalendar,
  inputs: readonly OpeningDriveReplaySessionInput[],
  binding: OpeningDriveQualificationBinding,
): Result.Result<string, OpeningDriveQualificationFailure> => {
  const fail = (message: string, sessionDate?: string) =>
    Result.fail(
      new OpeningDriveQualificationFailure({
        reason: 'session-order',
        message,
        ...(sessionDate === undefined ? {} : { sessionDate }),
      }),
    )
  if (
    calendar.schemaVersion !== 'bayn.opening-drive.qualification-calendar.v1' ||
    calendar.source !== 'signal.exchange_sessions_v1'
  ) {
    return fail('opening-drive qualification calendar schema and source do not match the reviewed contract')
  }
  if (calendar.sessions.length === 0 || calendar.calendarVersion.trim().length === 0) {
    return fail('opening-drive qualification requires a non-empty finalized exchange calendar')
  }
  if (!canonicalInstant(calendar.finalizedAt)) {
    return fail('opening-drive qualification calendar finalization time is invalid')
  }
  const first = calendar.sessions[0]
  const last = calendar.sessions.at(-1)
  if (
    first === undefined ||
    last === undefined ||
    calendar.firstSession !== first.sessionDate ||
    calendar.lastSession !== last.sessionDate ||
    calendar.finalizedAt < last.closeAt
  ) {
    return fail('opening-drive qualification calendar bounds do not match its complete finalized sessions')
  }
  let previous: string | undefined
  for (const session of calendar.sessions) {
    if (
      (previous !== undefined && session.sessionDate <= previous) ||
      session.openAt.slice(0, 10) !== session.sessionDate ||
      session.closeAt.slice(0, 10) !== session.sessionDate ||
      session.openAt >= session.closeAt ||
      !/^[0-9a-f]{64}$/.test(session.calendarHash) ||
      !canonicalInstant(session.openAt) ||
      !canonicalInstant(session.closeAt)
    ) {
      return fail(
        'opening-drive qualification calendar sessions must be complete, unique, and canonical',
        session.sessionDate,
      )
    }
    previous = session.sessionDate
  }
  if (inputs.length !== calendar.sessions.length) {
    return fail('opening-drive qualification inputs must cover every finalized calendar session exactly once')
  }
  for (const [index, input] of inputs.entries()) {
    const expected = calendar.sessions[index]
    const observed = input.opening.session
    if (
      expected === undefined ||
      observed.sessionDate !== expected.sessionDate ||
      observed.openAt !== expected.openAt ||
      observed.closeAt !== expected.closeAt ||
      observed.calendarHash !== expected.calendarHash
    ) {
      return fail(
        'opening-drive qualification input does not match the complete finalized calendar',
        observed.sessionDate,
      )
    }
  }
  const { contentHash, ...material } = calendar
  return Result.flatMap(
    Result.mapError(
      canonicalHashV1Result(material),
      (cause) =>
        new OpeningDriveQualificationFailure({
          reason: 'canonicalization',
          message: 'opening-drive qualification calendar is not canonically hashable',
          cause,
        }),
    ),
    (expectedHash) =>
      expectedHash === contentHash && contentHash === binding.evaluationCalendarHash
        ? Result.succeed(contentHash)
        : fail('opening-drive qualification calendar does not match its finalized precommitted content'),
  )
}

const validateSessionOrder = (
  inputs: readonly OpeningDriveReplaySessionInput[],
): Result.Result<void, OpeningDriveQualificationFailure> => {
  const snapshotIds = new Set<string>()
  let previous: string | undefined
  for (const input of inputs) {
    const sessionDate = input.opening.session.sessionDate
    if (previous !== undefined && sessionDate <= previous) {
      return Result.fail(
        new OpeningDriveQualificationFailure({
          reason: 'session-order',
          message: 'opening-drive qualification sessions must be unique and strictly increasing',
          sessionDate,
        }),
      )
    }
    for (const snapshotId of [input.opening.snapshot.manifest.snapshotId, input.exit.manifest.snapshotId]) {
      if (snapshotIds.has(snapshotId)) {
        return Result.fail(
          new OpeningDriveQualificationFailure({
            reason: 'session-order',
            message: 'opening-drive qualification cannot reuse a market snapshot',
            sessionDate,
          }),
        )
      }
      snapshotIds.add(snapshotId)
    }
    previous = sessionDate
  }
  return Result.succeed(undefined)
}

const validatePrecommittedHashes = (
  binding: OpeningDriveQualificationBinding,
  hashes: {
    readonly protocolHash: string
    readonly policyHash: string
    readonly costModelHash: string
  },
): Result.Result<void, OpeningDriveQualificationFailure> =>
  binding.protocolHash === hashes.protocolHash &&
  binding.strategyBehaviorHash === openingDriveBehaviorHash &&
  binding.policyHash === hashes.policyHash &&
  binding.costModelHash === hashes.costModelHash
    ? Result.succeed(undefined)
    : Result.fail(
        new OpeningDriveQualificationFailure({
          reason: 'trial-lineage',
          message:
            'opening-drive replay inputs do not match the executable strategy, precommitted protocol, policy, and cost model',
        }),
      )

export interface QualifyOpeningDriveInput {
  readonly sessions: readonly OpeningDriveReplaySessionInput[]
  readonly calendar: OpeningDriveQualificationCalendar
  readonly protocol: OpeningDriveProtocol
  readonly binding: OpeningDriveQualificationBinding
  readonly policy?: OpeningDriveQualificationPolicy
}

export const qualifyOpeningDrive = (
  input: QualifyOpeningDriveInput,
): Result.Result<OpeningDriveQualificationRun, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    const policy = input.policy ?? defaultOpeningDriveQualificationPolicy
    yield* validateOpeningDriveQualificationPolicy(policy)
    yield* validateSessionOrder(input.sessions)
    const calendarHash = yield* validateQualificationCalendar(input.calendar, input.sessions, input.binding)
    const hashes = yield* Result.all({
      protocolHash: Result.mapError(
        hashOpeningDriveProtocol(input.protocol),
        (cause) =>
          new OpeningDriveQualificationFailure({
            reason: 'canonicalization',
            message: 'opening-drive protocol is not canonically hashable for qualification',
            cause,
          }),
      ),
      policyHash: hashOpeningDriveQualificationPolicy(policy),
      costModelHash: hashOpeningDriveReplayCostModel(),
      calendarHash: Result.succeed(calendarHash),
      replayVersionGraphHash: hashOpeningDriveReplayVersionGraphFromInputs(input.sessions),
    })
    if (hashes.replayVersionGraphHash !== input.binding.replayVersionGraphHash) {
      return yield* Result.fail(
        new OpeningDriveQualificationFailure({
          reason: 'trial-lineage',
          message: 'opening-drive replay inputs do not match the precommitted archive version graph',
        }),
      )
    }
    yield* validatePrecommittedHashes(input.binding, hashes)
    const sessions = Object.freeze(
      yield* Result.all(input.sessions.map((session) => replayOpeningDriveSession(session, input.protocol, policy))),
    )
    const receipt = yield* analyzeOpeningDriveQualification(sessions, policy, input.binding, hashes)
    return Object.freeze({ sessions, receipt })
  })
