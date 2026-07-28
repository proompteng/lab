import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import { makeCandidate6Decision } from './decision'
import { candidate6Protocol, type Candidate6DecisionInput, type Candidate6Protocol } from './model'
import { simulateCandidate6 } from './simulation'

const behaviorCalendar = [
  '2021-12-27',
  '2021-12-28',
  '2021-12-29',
  '2021-12-30',
  '2021-12-31',
  '2022-01-03',
  '2022-01-04',
  '2022-01-05',
  '2022-01-06',
  '2022-01-07',
  '2022-01-10',
  '2022-01-11',
  '2022-01-12',
  '2022-01-13',
  '2022-01-14',
  '2022-01-18',
  '2022-01-19',
  '2022-01-20',
  '2022-01-21',
  '2022-01-24',
  '2022-01-25',
  '2022-01-26',
  '2022-01-27',
  '2022-01-28',
  '2022-01-31',
  '2022-02-01',
  '2022-02-02',
  '2022-02-03',
  '2022-02-04',
] as const satisfies readonly IsoDate[]

const behaviorBar = (sessionDate: IsoDate): DailyBar => {
  const close = sessionDate === '2022-01-25' ? 99 : 100
  const open = sessionDate === '2022-01-26' ? 99 : 100
  return {
    symbol: 'SPY',
    sessionDate,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 2_000_000,
    source: DataSource.Alpaca,
    sourceFeed: DataFeed.Sip,
    adjustment: PriceAdjustment.All,
    publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
  }
}

const behaviorBars = behaviorCalendar.map(behaviorBar)

const decisionInput = (
  signalDate: IsoDate,
  executionDate: IsoDate,
  activeEntrySignalDate: IsoDate | null,
  currentWeight: number,
  protocol: Candidate6Protocol,
): Candidate6DecisionInput => ({
  signalDate,
  executionDate,
  publicationAsOf: signalDate,
  calendar: behaviorCalendar,
  bars: behaviorBars.filter((bar) => bar.sessionDate <= signalDate),
  position: { activeEntrySignalDate, currentWeights: { SPY: currentWeight } },
  portfolioEquityUsd: 1_000_000,
  finalizedAtEpochMilliseconds: 1,
  observedAtEpochMilliseconds: 2,
  protocol,
})

const resultEvidence = <A, E>(result: Result.Result<A, E>) =>
  Result.isSuccess(result)
    ? ({ outcome: 'success', value: result.success } as const)
    : ({ outcome: 'failure', failure: result.failure } as const)

export const candidate6ExecutableBehaviorHash = (protocol: Candidate6Protocol = candidate6Protocol) =>
  canonicalHashV1Result({
    schemaVersion: 'bayn.month-end-liquidity-reversal.executable-behavior.v1',
    vectors: {
      enter: resultEvidence(makeCandidate6Decision(decisionInput('2022-01-25', '2022-01-26', null, 0, protocol))),
      hold: resultEvidence(
        makeCandidate6Decision(decisionInput('2022-02-02', '2022-02-03', '2022-01-25', 0.3, protocol)),
      ),
      exit: resultEvidence(
        makeCandidate6Decision(decisionInput('2022-02-03', '2022-02-04', '2022-01-25', 0.3, protocol)),
      ),
      rejectFutureEntry: resultEvidence(
        makeCandidate6Decision(decisionInput('2022-01-10', '2022-01-11', '2022-01-25', 0.2, protocol)),
      ),
      rejectMissingActiveBar: resultEvidence(
        makeCandidate6Decision({
          ...decisionInput('2022-02-02', '2022-02-03', '2022-01-25', 0.3, protocol),
          bars: behaviorBars.filter((bar) => bar.sessionDate < '2022-02-02'),
        }),
      ),
      completeSimulation: resultEvidence(
        simulateCandidate6(behaviorCalendar, behaviorBars, behaviorCalendar[0], protocol, 1, true),
      ),
      truncatedSimulation: resultEvidence(
        simulateCandidate6(
          behaviorCalendar.slice(0, -4),
          behaviorBars.slice(0, -4),
          behaviorCalendar[0],
          protocol,
          1,
          true,
        ),
      ),
    },
  })
