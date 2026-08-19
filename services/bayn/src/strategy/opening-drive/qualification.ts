import { Result } from 'effect'

import {
  OpeningDriveQualificationFailure,
  type OpeningDriveQualificationBinding,
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
import { hashOpeningDriveProtocol, type OpeningDriveProtocol } from './protocol'

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

export interface QualifyOpeningDriveInput {
  readonly sessions: readonly OpeningDriveReplaySessionInput[]
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
    })
    const sessions = Object.freeze(
      yield* Result.all(input.sessions.map((session) => replayOpeningDriveSession(session, input.protocol, policy))),
    )
    const receipt = yield* analyzeOpeningDriveQualification(sessions, policy, input.binding, hashes)
    return Object.freeze({ sessions, receipt })
  })
