import { canonicalHashV1 } from '../hash'
import { intradayMomentumBehaviorHash } from '../strategy/intraday-momentum/decision'
import { streamingFixture } from './streaming-market-fixture'

export const historicalStreamingFixture = () => {
  const { cut, snapshot, protocol, query } = streamingFixture()
  const observedAtMs = Date.parse(snapshot.manifest.observedAt)
  const raw = [...snapshot.bars, ...snapshot.quotes, ...snapshot.trades].map((row) => ({
    availableAtMs: observedAtMs,
    record: {
      topic: row.sourceTopic,
      partition: row.sourcePartition,
      offset: row.sourceOffset,
      value: JSON.stringify({
        version: 2,
        provider: row.provider,
        feed: row.feed,
        delayClass: row.delayClass,
        marketSession: row.marketSession,
        symbol: row.symbol,
        eventTs: row.eventAt,
        ingestTs: row.ingestedAt,
        channel: 'open' in row ? row.channel : 'bidPrice' in row ? 'quotes' : 'trades',
        isFinal: 'open' in row ? row.final : true,
        payload: {
          t: row.eventAt,
          ...('open' in row
            ? {
                o: row.open,
                h: row.high,
                l: row.low,
                c: row.close,
                v: row.volume,
                vw: row.vwap,
                n: row.tradeCount === null ? null : Number(row.tradeCount),
              }
            : 'bidPrice' in row
              ? { bp: row.bidPrice, ap: row.askPrice, bs: row.bidSize, as: row.askSize }
              : { p: row.price, s: row.size }),
        },
      }),
    },
  }))
  const features = [...cut.projection.features.values()].flat().map((feature, partition) => ({
    availableAtMs: observedAtMs,
    record: { topic: feature.topic, partition, offset: feature.offset, value: JSON.stringify(feature.value) },
  }))
  const input = {
    schemaVersion: 'bayn.historical-streaming-strategy-input.v1',
    protocolHash: canonicalHashV1(protocol),
    behaviorHash: intradayMomentumBehaviorHash,
    sessionDate: '2026-09-04',
    calendar: [{ date: '2026-09-04', open: '09:30', close: '16:00' }],
    arrivals: {
      schemaVersion: 'bayn.historical-market-arrivals.v1',
      runId: 'a'.repeat(64),
      observedAtMs,
      deliveryModel: {
        schemaVersion: 'bayn.supplied-arrival-times.v1',
        description: 'All retained records available at the supplied observation',
        tieBreak: 'availability-topic-partition-offset',
      },
      events: [...raw, ...features],
    },
  }
  return { input, snapshot, protocol, raw, features, query }
}
