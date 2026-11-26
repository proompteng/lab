import { Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../jev/protocol'
import { reproduceTrailingBaselineAcquisition } from '../market-data/intraday/baseline-acquisition'
import { buildTrailingBaseline, noiseAreaCheckpointMinutes } from '../market-data/intraday/trailing-baseline'
import { IsoDateSchema } from '../schemas'
import { makeIntradayAlphaPolicy } from '../strategy/intraday-alpha/policy'
import {
  alphaBaselinePreparationIdentity,
  reproduceAlphaBaselinePreparation,
  type RecordedAlphaBaselinePreparation,
} from './alpha-baseline-preparation'

/** Synthetic input fixture only; it is never evidence of an actual provider acquisition. */
export const preparedAlphaBaselineFixture = (): RecordedAlphaBaselinePreparation => {
  const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)('2026-09-04')
  const policy = makeIntradayAlphaPolicy(Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument)))
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      [{ session_open: '0400', session_close: '2000', date: sessionDate, open: '09:30', close: '16:00' }],
      { start: sessionDate, end: sessionDate },
    ),
  )
  const request = {
    cycleId: 'c'.repeat(64),
    authorityGenerationHash: 'a'.repeat(64),
    accountId: 'alpha-test-account',
    sessionDate,
    calendar,
    policy,
  }
  const executionBuild = {
    sourceRevision: 'e'.repeat(40),
    imageRepository: 'ghcr.io/proompteng/bayn',
    imageDigest: `sha256:${'d'.repeat(64)}`,
  }
  const { query } = Result.getOrThrow(alphaBaselinePreparationIdentity(request, executionBuild))
  const dates = [
    '2026-08-14',
    '2026-08-17',
    '2026-08-18',
    '2026-08-19',
    '2026-08-20',
    '2026-08-21',
    '2026-08-24',
    '2026-08-25',
    '2026-08-26',
    '2026-08-27',
    '2026-08-28',
    '2026-08-31',
    '2026-09-01',
    '2026-09-02',
    '2026-09-03',
  ].map((day) => Schema.decodeUnknownSync(IsoDateSchema)(day))
  const intradayDailyRows = query.symbols.flatMap((symbol, index) =>
    dates.map((date, day) => ({
      symbol,
      sessionDate: date,
      open: 100 + index + day / 10,
      high: 103 + index + day / 10,
      low: 98 + index + day / 10,
      close: 101 + index + day / 10,
    })),
  )
  const checkpointRows = intradayDailyRows
    .filter((row) => query.noiseAreaSymbols.includes(row.symbol))
    .flatMap((row) =>
      noiseAreaCheckpointMinutes.map((minuteFromOpen) => ({
        symbol: row.symbol,
        sessionDate: row.sessionDate,
        minuteFromOpen,
        close: row.open + minuteFromOpen / 100,
      })),
    )
  const trailingBaseline = Result.getOrThrow(
    buildTrailingBaseline({ ...query, dailyRows: intradayDailyRows, checkpointRows }),
  )
  const source = Result.getOrThrow(
    reproduceAlphaBaselinePreparation({
      schemaVersion: 'bayn.intraday-alpha-baseline-preparation.v1',
      ...request,
      executionBuild,
      acquisition: {
        schemaVersion: 'bayn.intraday-alpha-baseline-acquisition.v1',
        query,
        startedAt: '2026-09-04T12:01:02.000Z',
        completedAt: '2026-09-04T12:01:03.000Z',
        inputs: { intradayDailyRows, checkpointRows, adjustedDailyFallback: null },
        trailingBaseline,
      },
    }),
  )
  return { contentHash: source.contentHash, payload: source.payload, recordedAt: '2026-09-04T12:01:03.001Z' }
}

/** Reproducible partial inputs, without claiming they satisfy preopen preparation readiness. */
export const partialAlphaBaselineAcquisitionFixture = (
  missing: 'symbols' | 'checkpoint' = 'symbols',
  startedAt = '2026-09-04T12:01:02.000Z',
  completedAt = '2026-09-04T12:01:03.000Z',
) => {
  const source = preparedAlphaBaselineFixture().payload.acquisition
  const intradayDailyRows =
    missing === 'symbols'
      ? source.inputs.intradayDailyRows.filter((row) => row.symbol === 'AAPL')
      : source.inputs.intradayDailyRows
  const checkpointRows =
    missing === 'symbols'
      ? []
      : source.inputs.checkpointRows.filter((row) => row.symbol !== 'QQQ' || row.minuteFromOpen !== 31)
  return Result.getOrThrow(
    reproduceTrailingBaselineAcquisition({
      ...source,
      startedAt,
      completedAt,
      inputs: { intradayDailyRows, checkpointRows, adjustedDailyFallback: null },
      trailingBaseline: Result.getOrThrow(
        buildTrailingBaseline({ ...source.query, dailyRows: intradayDailyRows, checkpointRows }),
      ),
    }),
  )
}
