import type { IsoDate } from '../../schemas'
import type { AlphaV3Market, SipBar, SipSymbol } from './market'
import type { AlphaV3SignalState } from './signals'

type Session = AlphaV3Market['session']

export const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000))
export const iso = (ms: number) => new Date(ms).toISOString()
export const at = (session: Session, minutes: number) => iso(Date.parse(session.regularOpenAt) + minutes * 60_000)

export const blackFriday: Session = {
  date: '2026-11-27',
  regularOpenAt: '2026-11-27T14:30:00.000Z',
  regularCloseAt: '2026-11-27T18:00:00.000Z',
  sessionOpenAt: '2026-11-27T13:00:00.000Z',
  sessionCloseAt: '2026-11-27T22:00:00.000Z',
}

export const regularSession = (date: IsoDate): Session => ({
  date,
  regularOpenAt: `${date}T14:30:00.000Z`,
  regularCloseAt: `${date}T21:00:00.000Z`,
  sessionOpenAt: `${date}T13:00:00.000Z`,
  sessionCloseAt: `${date}T22:00:00.000Z`,
})

export const bar = (session: Session, symbol: SipSymbol, slot: number, overrides: Partial<SipBar> = {}): SipBar => ({
  symbol,
  startAt: at(session, slot * 5),
  availableAt: at(session, (slot + 1) * 5),
  openMicros: usd(100).toString(),
  closeMicros: usd(100).toString(),
  highMicros: usd(101).toString(),
  lowMicros: usd(99).toString(),
  vwapMicros: usd(100).toString(),
  volume: '100',
  ...overrides,
})

const priorDates: readonly IsoDate[] = [
  '2026-11-05',
  '2026-11-06',
  '2026-11-09',
  '2026-11-10',
  '2026-11-11',
  '2026-11-12',
  '2026-11-13',
  '2026-11-16',
  '2026-11-17',
  '2026-11-18',
  '2026-11-19',
  '2026-11-20',
  '2026-11-23',
  '2026-11-24',
  '2026-11-25',
]

export const market = (
  symbols: readonly SipSymbol[],
  cutoffMinute: number,
  bars: readonly SipBar[],
  session: Session = blackFriday,
): AlphaV3Market => ({
  schemaVersion: 'bayn.intraday-alpha-sip-market.v1',
  feed: 'alpaca-sip',
  barMinutes: 5,
  session,
  cutoffAt: at(session, cutoffMinute),
  observedAt: iso(Date.parse(at(session, cutoffMinute)) + 1000),
  openingObservedAt: iso(Date.parse(at(session, 5)) + 1000),
  bars,
  statuses: symbols.map((symbol) => ({
    symbol,
    active: true,
    effectiveAt: session.regularOpenAt,
    availableAt: session.sessionOpenAt,
  })),
  priorSessions: priorDates.map((date) => {
    const prior = regularSession(date)
    return {
      session: prior,
      bars: symbols.flatMap((symbol) =>
        Array.from({ length: 78 }, (_, slot) =>
          bar(
            prior,
            symbol,
            slot,
            (symbol === 'QQQ' || symbol === 'SMH') && slot % 6 === 5 ? { closeMicros: usd(101).toString() } : {},
          ),
        ),
      ),
    }
  }),
})

export const emptyState: AlphaV3SignalState = {
  occupiedSymbols: new Set(),
  noiseUsed: new Set(),
  noisePositions: new Map(),
  orbUsed: false,
  noonUsed: false,
}
