import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { Profile, universe } from './policy'
import { closeSnapshotSchema } from './signals'

export const preset = (profile = Profile.F2) => ({ schema: 'bayn.macro-etf-core-policy.v1', profile }) as const

export const fixture = (length = 184) => {
  const start = Date.parse('2016-01-04T14:30:00Z')
  const calendar = Array.from({ length: length + 1 }, (_, t) => {
    const openAt = start + (t + 2 * Math.floor(t / 5)) * 86_400_000
    return { openAt, closeAt: openAt + 23_400_000, date: new Date(openAt).toISOString().slice(0, 10) }
  })
  const bars = calendar.slice(0, -1).map(({ date, closeAt }, t) =>
    universe.flatMap((symbol, i) => {
      if ((symbol === 'XLC' && t < 117) || (symbol === 'XLRE' && (t === 28 || t === 158))) return []
      const close = 70 + i + t * (((i + 2) % 7) - 2) * 0.052 + Math.sin((t + 2 * i) / (4 + (i % 11))) * ((i % 5) + 1)
      const open = close - 0.07
      return [{ symbol, date, open, close, low: open - 0.5, high: close + 0.5, availableAt: closeAt + 60_000 }]
    }),
  )
  return { asOf: calendar[length].openAt, calendar, bars }
}

export const evidence = ({ asOf, calendar, bars }: ReturnType<typeof fixture>) => {
  const snapshot = {
    schema: closeSnapshotSchema,
    datasetVersion: 'golden-fixture.v1',
    adjustment: 'all',
    calendar,
    bars,
  }
  return { asOf, snapshot, snapshotHash: Result.getOrThrow(canonicalHashV1Result(snapshot)) }
}
