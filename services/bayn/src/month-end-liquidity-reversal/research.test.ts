import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { parseCandidate6DevelopmentCsv } from './development-data'
import type { Candidate6DevelopmentDataset } from './model'
import { makeSealedCandidate6Preregistration } from './preregistration'
import {
  CANDIDATE_6_DEVELOPMENT_DATA_START,
  CANDIDATE_6_DEVELOPMENT_END,
  CANDIDATE_6_HOLDOUT_START,
  buildCandidate6DevelopmentReport,
  type Candidate6ResearchFailure,
} from './research'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'fixture must succeed')
  return result.success
}

const failure = <A>(result: Result.Result<A, Candidate6ResearchFailure>): Candidate6ResearchFailure => {
  assert(Result.isFailure(result), 'fixture must fail')
  return result.failure
}

const weekdays = (start: IsoDate, end: IsoDate): readonly IsoDate[] => {
  const dates: IsoDate[] = []
  const cursor = new Date(`${start}T00:00:00.000Z`)
  const final = new Date(`${end}T00:00:00.000Z`)
  while (cursor <= final) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10) as IsoDate)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

const syntheticDataset = (): Candidate6DevelopmentDataset => {
  const calendar = weekdays(CANDIDATE_6_DEVELOPMENT_DATA_START, CANDIDATE_6_DEVELOPMENT_END)
  const signalDates = new Set<IsoDate>()
  for (let index = 0; index < calendar.length; index += 1) {
    const current = calendar[index]
    if (current === undefined) continue
    const month = current.slice(0, 7)
    let remaining = 0
    for (let cursor = index + 1; cursor < calendar.length; cursor += 1) {
      if ((calendar[cursor] ?? '').slice(0, 7) !== month) break
      remaining += 1
    }
    if (remaining === 4) signalDates.add(current)
  }
  const bars = calendar.map((sessionDate, index): DailyBar => {
    const priorDate = calendar[index - 1]
    const signal = signalDates.has(sessionDate)
    const afterSignal = priorDate !== undefined && signalDates.has(priorDate)
    const close = signal ? 99.5 : 100
    const open = afterSignal ? 99.5 : close
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
  })
  return {
    snapshotId: 'synthetic-development-only',
    rawExportSha256: 'a'.repeat(64),
    firstSession: CANDIDATE_6_DEVELOPMENT_DATA_START,
    lastSession: CANDIDATE_6_DEVELOPMENT_END,
    barCount: bars.length,
    bars,
  }
}

describe('candidate 6 development data decoder', () => {
  test('decodes the immutable ClickHouse CSV contract and hashes raw bytes', () => {
    const csv = [
      '"symbol","toString(session_date)","toString(adjusted_open)","toString(adjusted_high)","toString(adjusted_low)","toString(adjusted_close)","toString(adjusted_volume)","provider","source_feed","adjustment"',
      '"SPY","2016-01-04","100","101","99","100.5","2000000","alpaca","sip","all"',
      '',
    ].join('\n')
    const dataset = success(parseCandidate6DevelopmentCsv(csv, 'snapshot'))
    expect(dataset).toMatchObject({
      snapshotId: 'snapshot',
      firstSession: '2016-01-04',
      lastSession: '2016-01-04',
      barCount: 1,
    })
    expect(dataset.rawExportSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(dataset.bars[0]).toMatchObject({ symbol: 'SPY', close: 100.5, source: 'alpaca' })
  })

  test('fails closed for malformed CSV, headers, numbers, and enums', () => {
    const header =
      '"symbol","toString(session_date)","toString(adjusted_open)","toString(adjusted_high)","toString(adjusted_low)","toString(adjusted_close)","toString(adjusted_volume)","provider","source_feed","adjustment"'
    const cases = [
      ['"unterminated', 'InvalidCsv'],
      ['"wrong"\n', 'InvalidCsvHeader'],
      [`${header}\n"SPY","bad","1","2","1","1","2","alpaca","sip","all"\n`, 'InvalidCsvDate'],
      [`${header}\n"SPY","2016-01-04","nan","2","1","1","2","alpaca","sip","all"\n`, 'InvalidCsvNumber'],
      [`${header}\n"SPY","2016-01-04","1","2","1","1","2","other","sip","all"\n`, 'InvalidCsvEnum'],
    ] as const
    for (const [csv, tag] of cases) {
      const decoded = parseCandidate6DevelopmentCsv(csv, 'snapshot')
      assert(Result.isFailure(decoded))
      expect(decoded.failure._tag).toBe(tag)
    }
  })
})

describe('candidate 6 deterministic development simulation', () => {
  test('is deterministic, order invariant, bounded, and cost sensitive', () => {
    const dataset = syntheticDataset()
    const ordered = success(buildCandidate6DevelopmentReport(dataset))
    const reversed = success(buildCandidate6DevelopmentReport({ ...dataset, bars: [...dataset.bars].reverse() }))

    expect(reversed).toEqual(ordered)
    expect(ordered.status).toBe('DEVELOPMENT_ONLY_HOLDOUT_UNTOUCHED')
    expect(ordered.identity.parameterHash).toBe(success(makeSealedCandidate6Preregistration()).identity.parameterHash)
    expect(ordered.dataset.untouchedHoldoutStart).toBe(CANDIDATE_6_HOLDOUT_START)
    expect(ordered.net.observationCount).toBeGreaterThanOrEqual(1_500)
    expect(ordered.net.entryCount).toBeGreaterThan(0)
    expect(ordered.net.maximumGrossExposure).toBeLessThanOrEqual(0.35)
    expect(ordered.net.annualTurnover).toBeLessThanOrEqual(12)
    expect(ordered.gross.annualizedReturn).toBeGreaterThan(ordered.net.annualizedReturn)
    expect(ordered.costSensitivity.map((item) => item.metrics.annualizedReturn)).toEqual(
      [...ordered.costSensitivity]
        .sort((left, right) => left.costMultiplier - right.costMultiplier)
        .map((item) => item.metrics.annualizedReturn),
    )
    for (let index = 1; index < ordered.costSensitivity.length; index += 1) {
      expect(ordered.costSensitivity[index]?.metrics.annualizedReturn).toBeLessThanOrEqual(
        ordered.costSensitivity[index - 1]?.metrics.annualizedReturn ?? Number.POSITIVE_INFINITY,
      )
    }
    expect(ordered.confidenceInterval.annualizedReturn[0]).toBeLessThanOrEqual(
      ordered.confidenceInterval.annualizedReturn[1],
    )
    expect(ordered.reportHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('rejects any post-development row before simulation', () => {
    const dataset = syntheticDataset()
    const future: DailyBar = {
      ...(dataset.bars.at(-1) as DailyBar),
      sessionDate: CANDIDATE_6_HOLDOUT_START,
    }
    expect(
      failure(
        buildCandidate6DevelopmentReport({
          ...dataset,
          barCount: dataset.barCount + 1,
          bars: [...dataset.bars, future],
        }),
      ),
    ).toEqual({ _tag: 'InvalidDevelopmentBoundary', field: 'futureBar', observed: CANDIDATE_6_HOLDOUT_START })
  })
})
