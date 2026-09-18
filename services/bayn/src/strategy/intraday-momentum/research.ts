import { Data, Result, Schema } from 'effect'
import { Sha256Schema } from '../../schemas'
import { decodeIntradayMomentumProtocol, defaultIntradayMomentumProtocolDocument } from './protocol'

export enum IntradayExitTiming {
  Current = 'CURRENT',
  FifteenMinutes = 'CLOSE_15_MINUTES_BEFORE_BELL',
  ThirtyMinutes = 'CLOSE_30_MINUTES_BEFORE_BELL',
}

export const intradayExitTimingProtocol = (variant: IntradayExitTiming) => {
  const baseline = defaultIntradayMomentumProtocolDocument
  const flattenBeforeCloseMinutes = {
    [IntradayExitTiming.Current]: baseline.flattenBeforeCloseMinutes,
    [IntradayExitTiming.FifteenMinutes]: 15,
    [IntradayExitTiming.ThirtyMinutes]: 30,
  }[variant]
  const entryCutoffMinutesBeforeClose = Math.max(baseline.entryCutoffMinutesBeforeClose, flattenBeforeCloseMinutes)
  return decodeIntradayMomentumProtocol({
    ...baseline,
    flattenBeforeCloseMinutes,
    entryCutoffMinutesBeforeClose,
    executionModel: {
      ...baseline.executionModel,
      order: {
        ...baseline.executionModel.order,
        submissionCutoffBeforeCloseMs: entryCutoffMinutesBeforeClose * 60_000,
      },
    },
  })
}

class IntradayResearchProtocolFailure extends Data.TaggedError('IntradayResearchProtocolFailure')<{
  readonly message: string
}> {}

export const replayIntradayProtocol = (input: {
  readonly accountId: string
  readonly runId: string
  readonly exitTiming: IntradayExitTiming
}) =>
  Result.gen(function* () {
    if (!Schema.is(Sha256Schema)(input.runId) || input.accountId !== `replay-${input.runId}`)
      return yield* Result.fail(
        new IntradayResearchProtocolFailure({ message: 'Simulated exit timing requires its synthetic replay account' }),
      )
    return yield* intradayExitTimingProtocol(input.exitTiming)
  })
