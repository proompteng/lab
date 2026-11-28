import { Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../jev/protocol'
import { reproduceTrailingBaselineAcquisition } from '../market-data/intraday/baseline-acquisition'
import { buildTrailingBaseline, noiseAreaCheckpointMinutes } from '../market-data/intraday/trailing-baseline'
import { IsoDateSchema } from '../schemas'
import { isPureEtfPolicy, makeIntradayAlphaPolicy, type IntradayAlphaPolicy } from '../strategy/intraday-alpha/policy'
import {
  alphaBaselinePreparationIdentity,
  reproduceAlphaBaselinePreparation,
  type RecordedAlphaBaselinePreparation,
} from './alpha-baseline-preparation'

/** Synthetic input fixture only; it is never evidence of an actual provider acquisition. */
export const preparedAlphaBaselineFixture = (
  date = '2026-09-04',
  policy: IntradayAlphaPolicy = makeIntradayAlphaPolicy(
    Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument)),
  ),
): RecordedAlphaBaselinePreparation => {
  const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)(date)
  const pureEtf = isPureEtfPolicy(policy)
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
  const { query, nativeSession } = Result.getOrThrow(alphaBaselinePreparationIdentity(request, executionBuild))
  const dates = Array.from({ length: 23 }, (_, index) => new Date(Date.parse(sessionDate) - (23 - index) * 86_400_000))
    .filter((day) => day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && day.toISOString().slice(0, 10) !== '2026-11-26')
    .slice(pureEtf ? -15 : -14)
    .map((day) => Schema.decodeUnknownSync(IsoDateSchema)(day.toISOString().slice(0, 10)))
  const history = pureEtf
    ? {
        historySessions: dates.map((date) => ({
          date,
          openAt: `${date}T13:30:00.000Z`,
          closeAt: `${date}T20:00:00.000Z`,
        })),
      }
    : {}
  const startedAt = new Date(Date.parse(nativeSession.openAt) + 62_000).toISOString()
  const completedAt = new Date(Date.parse(startedAt) + 1_000).toISOString()
  const intradayDailyRows = query.symbols.flatMap((symbol, index) =>
    dates.map((date, day) => ({
      symbol,
      sessionDate: date,
      open: pureEtf ? (index === 0 ? 500 : 250) : 100 + index + day / 10,
      high: pureEtf ? (index === 0 ? 505 : 260) : 103 + index + day / 10,
      low: pureEtf ? (index === 0 ? 495 : 240) : 98 + index + day / 10,
      close: pureEtf ? (index === 0 ? 500 + (day % 2) * 5 : 250 + (day % 2) * 10) : 101 + index + day / 10,
    })),
  )
  const checkpointRows = intradayDailyRows
    .filter((row) => query.noiseAreaSymbols.includes(row.symbol))
    .flatMap((row) =>
      (query.checkpointMinutesFromOpen ?? noiseAreaCheckpointMinutes).map((minuteFromOpen) => ({
        symbol: row.symbol,
        sessionDate: row.sessionDate,
        minuteFromOpen,
        close: pureEtf ? row.open * 1.004 : row.open + minuteFromOpen / 100,
      })),
    )
  const trailingBaseline = Result.getOrThrow(
    buildTrailingBaseline({ ...query, ...history, dailyRows: intradayDailyRows, checkpointRows }),
  )
  const source = Result.getOrThrow(
    reproduceAlphaBaselinePreparation({
      schemaVersion: 'bayn.intraday-alpha-baseline-preparation.v1',
      ...request,
      executionBuild,
      acquisition: {
        schemaVersion: 'bayn.intraday-alpha-baseline-acquisition.v1',
        query,
        startedAt,
        completedAt,
        inputs: { ...history, intradayDailyRows, checkpointRows, adjustedDailyFallback: null },
        trailingBaseline,
      },
    }),
  )
  return {
    contentHash: source.contentHash,
    payload: source.payload,
    recordedAt: new Date(Date.parse(completedAt) + 1).toISOString(),
  }
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
