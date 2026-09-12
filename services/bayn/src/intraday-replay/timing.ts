import { utcInstantFromEpochMillis } from '../time'
import type { IntradayReplayOperationalTiming } from './model'

export interface IntradayReplayTimeline {
  readonly sourceCutoffAt: string
  readonly decisionReadCompletedAt: string | null
  readonly decisionCompletedAt: string | null
  readonly planningReadCompletedAt: string
  readonly planCompletedAt: string
  readonly committedAt: string
  readonly submittedAt: string
  readonly arrivedAt: string
}

/** Durations are explicit experiment inputs, not measured broker or venue timestamps. */
export const intradayReplayTimeline = (
  sourceCutoffAt: string,
  purpose: 'entry' | 'close',
  timing: IntradayReplayOperationalTiming,
  orderLatencyMs: number,
): IntradayReplayTimeline => {
  let current = Date.parse(sourceCutoffAt)
  const advance = (durationMs: number): string => {
    current += durationMs
    return utcInstantFromEpochMillis(current)
  }
  const decisionReadCompletedAt = purpose === 'entry' ? advance(timing.decisionReadMs) : null
  const decisionCompletedAt = purpose === 'entry' ? advance(timing.decisionComputeMs) : null
  return {
    sourceCutoffAt,
    decisionReadCompletedAt,
    decisionCompletedAt,
    planningReadCompletedAt: advance(timing.planningReadMs),
    planCompletedAt: advance(timing.planningComputeMs),
    committedAt: advance(timing.commitMs),
    submittedAt: advance(timing.submissionMs),
    arrivedAt: advance(orderLatencyMs),
  }
}
