import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { withProviderSessions } from '../../testing/market-calendar-fixture'
import {
  defaultMultiAssetEtfPolicy,
  makeMultiAssetEtfPolicy,
  multiAssetEtfs,
  sleeveNames,
  type EtfSleeve,
  type MultiAssetEtf,
  type MultiAssetEtfPolicyMaterial,
} from './policy'
import type { AdjustedEtfBar, MultiAssetEtfMarket } from './signals'

const holidays = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
])
const halfDays = new Set(['2026-11-27', '2026-12-24'])
const sessions = Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i))).flatMap((day) => {
  const date = day.toISOString().slice(0, 10)
  if (day.getUTCDay() === 0 || day.getUTCDay() === 6 || holidays.has(date)) return []
  const daylight = date >= '2026-03-08' && date < '2026-11-01'
  const open = daylight ? '13:30:00' : '14:30:00'
  const close = halfDays.has(date) ? (daylight ? '17:00:00' : '18:00:00') : daylight ? '20:00:00' : '21:00:00'
  return [{ date, openAt: `${date}T${open}.000Z`, closeAt: `${date}T${close}.000Z` }]
})

export const fixtureCalendar = withProviderSessions({
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v2' as const,
  source: 'alpaca-v2-calendar' as const,
  timeZone: 'UTC' as const,
  requestedRange: { start: '2026-01-01', end: '2026-12-31' },
  sessions,
})

const calendar = {
  ...fixtureCalendar,
  normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(fixtureCalendar)),
}
export const barAt = (close: number): AdjustedEtfBar => ({
  open: close * 0.999,
  high: close * 1.01,
  low: close * 0.99,
  close,
  volume: 1_000_000,
})

export const fixtureBars: MultiAssetEtfMarket['barsBySession'] = Object.fromEntries(
  sessions.map(({ date }, i) => [
    date,
    Object.fromEntries(
      multiAssetEtfs.map((symbol, j) => {
        // Distinct signed trends, covariance and pullbacks; SPY/TLT also span the pension trigger.
        const slope = symbol === 'HYG' ? 0.002 : ((j % 7) - 2) * 0.0009
        const noise = ((j % 5) + 1) * 0.005 * Math.sin((i * ((j % 3) + 2)) / 4 + j)
        return [symbol, barAt((80 + j) * Math.exp(i * slope + noise))]
      }),
    ),
  ]),
)

export const marketAt = (executionSession: string, barsBySession = fixtureBars): MultiAssetEtfMarket => {
  const previous = sessions[sessions.findIndex(({ date }) => date === executionSession) - 1]
  if (previous === undefined) throw new Error(`No prior session for ${executionSession}`)
  return { calendar, executionSession, adjustment: 'all', adjustmentAsOfSession: previous.date, barsBySession }
}

export const policyAt = (sleeve?: EtfSleeve, overrides: Partial<MultiAssetEtfPolicyMaterial> = {}) => {
  const { policyHash: _policyHash, ...material } = Result.getOrThrow(defaultMultiAssetEtfPolicy())
  const sleeves = { ...material.sleeves }
  if (sleeve !== undefined) {
    for (const name of sleeveNames) {
      const rule = { ...sleeves[name], capitalWeight: name === sleeve ? 1 : 0 }
      Object.assign(sleeves, { [name]: rule })
    }
  }
  return Result.getOrThrow(
    makeMultiAssetEtfPolicy({
      ...material,
      sleeves,
      historyStartSession: '2026-01-02',
      ...overrides,
    }),
  )
}

export const withoutBar = (session: string, symbol: MultiAssetEtf): MultiAssetEtfMarket['barsBySession'] => {
  const bars = { ...fixtureBars[session] }
  delete bars[symbol]
  return { ...fixtureBars, [session]: bars }
}
