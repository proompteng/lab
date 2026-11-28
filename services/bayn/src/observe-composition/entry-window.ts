import { Effect, Option } from 'effect'

import { jevSignalDueAtMs, jevSignalIntervalMs } from '../jev/observation-query'
import { JevPurpose } from '../jev/portfolio'
import type { JevProtocol } from '../jev/protocol'
import { utcInstantFromEpochMillis } from '../time'
import { CandidateObservationStore } from './candidate-observation'

/** An eligible time follows retained consumption; the eventual decision still verifies actual source arrival. */
export const nextJevEntryWindowDueAt = (
  cycleId: string,
  protocol: Pick<JevProtocol, 'decisionDelaySeconds'>,
  schemaVersion?:
    | 'bayn.jev-observation.v1'
    | 'bayn.intraday-alpha-observation.v1'
    | 'bayn.intraday-alpha-observation.v2',
) =>
  CandidateObservationStore.pipe(
    Effect.flatMap((store) =>
      store.latestJevWindowEnd({
        cycleId,
        purpose: JevPurpose.Entry,
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
      }),
    ),
    Effect.map(
      Option.map((windowEndAt) =>
        utcInstantFromEpochMillis(jevSignalDueAtMs(Date.parse(windowEndAt) + jevSignalIntervalMs, protocol)),
      ),
    ),
  )
