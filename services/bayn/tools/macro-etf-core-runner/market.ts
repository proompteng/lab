import { Clock, Effect } from 'effect'

import { canonicalHashV1Result } from '../../src/hash'
import { parameters, universe, type Etf } from '../../src/strategy/macro-etf-core/policy'
import { closeSnapshotSchema } from '../../src/strategy/macro-etf-core/signals'
import { BarAdjustment, type Alpaca } from '../macro-canary-runner/alpaca'
import { nyTime, readBars, readWindow } from '../macro-canary-runner/market'
import { failure } from './contract'

const optional = new Set<Etf>(parameters.optionalCandidates)

export const readMarket = Effect.fn('macro-etf-core.market')(function* (alpaca: Alpaca) {
  const now = yield* Clock.currentTimeMillis
  const window = yield* readWindow(alpaca, now, parameters.epoch, parameters.warmup)
  const calendar = window.sessions.map(({ date, open, close }) => ({
    date,
    openAt: nyTime(date, open),
    closeAt: nyTime(date, close),
  }))
  const history = calendar.slice(0, -1)
  const adjusted = yield* readBars(
    alpaca,
    universe,
    history.map(({ date }) => date),
    window.barEnd,
    BarAdjustment.All,
    optional,
  )
  const lastMidnight = nyTime(window.lastDate, '00:00')
  const missingCandidates = parameters.optionalCandidates.filter(
    (symbol) => adjusted.get(symbol)?.has(lastMidnight) !== true,
  )
  const raw = yield* readBars(
    alpaca,
    universe,
    [window.lastDate],
    window.barEnd,
    BarAdjustment.Raw,
    new Set<Etf>(missingCandidates),
  )
  const rawBars = [...raw].flatMap(([symbol, series]) => [...series.values()].map((bar) => ({ symbol, bar })))
  const snapshot = {
    schema: closeSnapshotSchema,
    datasetVersion: 'alpaca-sip-1day-all.v1',
    adjustment: BarAdjustment.All,
    calendar,
    bars: history.map(({ date }) => {
      const midnight = nyTime(date, '00:00')
      // Alpaca does not publish an availability timestamp for daily bars. Bind the close to our
      // conservative after-hours finalization boundary, not to the midnight session label.
      const availableAt = nyTime(date, '20:15')
      return universe.flatMap((symbol) => {
        const bar = adjusted.get(symbol)?.get(midnight)
        return bar === undefined
          ? []
          : [
              {
                symbol,
                date,
                availableAt,
                open: bar.o,
                high: bar.h,
                low: bar.l,
                close: bar.c,
              },
            ]
      })
    }),
  }
  const hash = (material: unknown) =>
    Effect.fromResult(canonicalHashV1Result(material)).pipe(
      Effect.mapError((cause) => failure('bars', 'Cannot hash market evidence', cause)),
    )
  const snapshotHash = yield* hash(snapshot)
  const barSha256 = yield* hash({
    calendar,
    feed: 'sip',
    timeframe: '1Day',
    adjustment: BarAdjustment.All,
    adjusted: [...adjusted].map(([symbol, series]) => ({ symbol, bars: [...series.values()] })),
    raw: { adjustment: BarAdjustment.Raw, rows: rawBars },
  })
  const asOf = yield* Clock.currentTimeMillis
  if (asOf >= window.cutoff) return yield* failure('calendar', 'Next-open window expired during market read')

  return {
    window,
    evidence: { snapshot, snapshotHash, asOf },
    missingCandidates,
    rawBars,
    barSha256,
  }
})

export type Market = Effect.Success<ReturnType<typeof readMarket>>
