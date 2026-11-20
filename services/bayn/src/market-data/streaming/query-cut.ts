import { Result } from 'effect'

import type { IntradayQuote, IntradaySnapshotQuery, IntradayTrade } from '../intraday/model'
import type { KafkaProjectionCut } from './kafka'
import { selectStreamingInputs } from './inputs'
import type { ObservedBar, ObservedFeature, ObservedMarketValue } from './projection'
import { prepareStreamingSnapshotCut, type StreamingFeatureReceipt } from './snapshot'
import { selectWebullBars } from './webull-projection'

const selectedFeatures = <A>(
  histories: ReadonlyMap<string, readonly ObservedFeature<A>[]>,
  receipts: readonly StreamingFeatureReceipt<A>[],
) => {
  const values = new Set(receipts.map((receipt) => receipt.value))
  return new Map(
    [...histories].flatMap(([symbol, history]) => {
      const selected = history.filter((entry) => values.has(entry.value))
      return selected.length === 0 ? [] : [[symbol, selected] as const]
    }),
  )
}

/** Preserve the original snapshot policy while transferring only query-owned inputs. */
export const compactStreamingProjection = (cut: KafkaProjectionCut, query: IntradaySnapshotQuery) =>
  Result.gen(function* () {
    const { request } = yield* prepareStreamingSnapshotCut(cut, query)
    const selected = yield* selectStreamingInputs(cut.projection, request)
    const state = cut.projection
    const bars = selected.entries.filter((entry): entry is ObservedBar => 'open' in entry.value)
    const quotes = selected.entries.filter(
      (entry): entry is ObservedMarketValue<IntradayQuote> => 'bidPrice' in entry.value,
    )
    const trades = selected.entries.filter(
      (entry): entry is ObservedMarketValue<IntradayTrade> => 'price' in entry.value,
    )
    return {
      ...state,
      bars: Map.groupBy(bars, (entry) => entry.value.symbol),
      quotes: new Map(quotes.map((entry) => [entry.value.symbol, entry])),
      trades: new Map(trades.map((entry) => [entry.value.symbol, entry])),
      quoteHistory: Map.groupBy(quotes, (entry) => entry.value.symbol),
      tradeHistory: Map.groupBy(trades, (entry) => entry.value.symbol),
      features: selectedFeatures(state.features, selected.featureReceipts),
      technicalFeatures: selectedFeatures(state.technicalFeatures, selected.technical?.features ?? []),
      featureArrival: null,
      technicalFeatureArrival: null,
      webull: {
        ...state.webull,
        bars: Map.groupBy(
          selectWebullBars(
            state.webull,
            selected.webull?.bars.map((bar) => bar.symbol) ?? [],
            Date.parse(request.rangeEndAt),
            Date.parse(request.observedAt),
          ),
          (entry) => entry.value.symbol,
        ),
      },
    }
  })
