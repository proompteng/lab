import { describe, expect, test } from 'bun:test'

import { admitUniverse, compareUniverse, readArchiveMetadata } from './8yr-unseen-intraday-data'
import { baselineNames, blind, noiseNames, stocks, universe } from './8yr-unseen-intraday-protocol'

describe('Wave 4E metadata admission', () => {
  test('rejects an equal-size manifest with an unrelated name replacing a strategy input', () => {
    const substituted = universe.map((symbol) => (symbol === 'INTC' ? 'ADBE' : symbol))
    expect(substituted).toHaveLength(62)
    expect(stocks).toHaveLength(46)
    expect([...baselineNames, ...noiseNames, 'SPY']).toHaveLength(21)
    expect(compareUniverse(substituted)).toEqual({
      missing: ['INTC'],
      unexpected: ['ADBE'],
      duplicates: [],
      listedWithoutRows: [],
    })
    expect(() => admitUniverse('blind', substituted)).toThrow('missing=[INTC]; unexpected=[ADBE]')
  })

  test('distinguishes missing rows for a listed name from a genuine post-window first listing', () => {
    const coverage = Object.fromEntries(universe.map((symbol) => [symbol, 1]))
    delete coverage['SNDK']
    delete coverage['GEV']
    delete coverage['ALAB']
    expect(() => admitUniverse('blind', universe, coverage)).not.toThrow()
    delete coverage['ARM']
    expect(() => admitUniverse('blind', universe, coverage)).toThrow('listedWithoutRows=[ARM]')
  })

  test('rejects duplicate members independently of a set match', () => {
    expect(() => admitUniverse('blind', [...universe, 'SPY'])).toThrow('duplicates=[SPY]')
  })

  test('rejects the mismatch without even requesting the calendar or any bar object', async () => {
    const objects: string[] = []
    const symbols = universe.map((symbol) => (symbol === 'INTC' ? 'ADBE' : symbol))
    const metadata = {
      dataset: 'alpaca-sip-8yr-5m-unseen-2016-2023',
      source: 'Alpaca Data API v2 (feed=sip, adjustment=split, timeframe=5Min)',
      dateRange: { start: blind.first, end: blind.last },
      calendarSessions: blind.sessions,
      symbolCount: 62,
      symbols,
      symbolRowCounts: { AAPL: blind.rows },
      totalRows: blind.rows,
      files: {
        bars_5m: { key: blind.bars, bytes: 1, sha256: 'a'.repeat(64) },
        calendar: { key: blind.calendar, bytes: 1, sha256: blind.calendarSha256 },
      },
    }
    await expect(
      readArchiveMetadata((key) => {
        objects.push(key)
        return Promise.resolve(metadata)
      }),
    ).rejects.toThrow('missing=[INTC]; unexpected=[ADBE]')
    expect(objects).toEqual([blind.manifest])
  })
})
