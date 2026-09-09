package ai.proompteng.dorvud.ta.stream

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.min

/**
 * Stateful 1s micro-bar aggregator. It maintains one in-flight bucket per symbol and flushes
 * whenever the event second advances. Flushes are driven by incoming traffic; a background flush
 * hook can be added if needed for idle symbols.
 */
class MicroBarAggregator {
  private data class Bucket(
    val windowStart: Instant,
    var open: Double,
    var high: Double,
    var low: Double,
    var close: Double,
    var volume: Double,
    var vwapNumerator: Double,
    var count: Long,
  )

  private val buckets = ConcurrentHashMap<String, Bucket>()

  fun onTrade(envelope: Envelope<TradePayload>): List<Envelope<MicroBarPayload>> {
    val symbol = envelope.symbol
    val secondStart = envelope.payload.t.truncatedTo(ChronoUnit.SECONDS)

    val existing = buckets[symbol]
    if (existing == null) {
      buckets[symbol] = newBucket(envelope.payload, secondStart)
      return emptyList()
    }

    return if (existing.windowStart == secondStart) {
      updateBucket(existing, envelope.payload)
      emptyList()
    } else {
      val flushed = flush(symbol, existing)
      buckets[symbol] = newBucket(envelope.payload, secondStart)
      listOf(flushed)
    }
  }

  fun flushAll(
    forceCurrent: Boolean = false,
    now: Instant = Instant.now(),
  ): List<Envelope<MicroBarPayload>> {
    val flushed = mutableListOf<Envelope<MicroBarPayload>>()
    val iterator = buckets.entries.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      val bucket = entry.value
      val second = now.truncatedTo(ChronoUnit.SECONDS)
      if (forceCurrent || bucket.windowStart.isBefore(second)) {
        flushed += flush(entry.key, bucket)
        iterator.remove()
      }
    }
    return flushed
  }

  private fun flush(
    symbol: String,
    bucket: Bucket,
  ): Envelope<MicroBarPayload> {
    val end = bucket.windowStart.plusSeconds(1)
    val payload =
      MicroBarPayload(
        o = bucket.open,
        h = bucket.high,
        l = bucket.low,
        c = bucket.close,
        v = bucket.volume,
        vwap = if (bucket.volume == 0.0) null else bucket.vwapNumerator / bucket.volume,
        count = bucket.count,
        t = end,
      )
    return Envelope(
      ingestTs = Instant.now(),
      eventTs = end,
      feed = "alpaca",
      channel = "trades",
      symbol = symbol,
      seq = 0,
      payload = payload,
      isFinal = true,
      source = "ta",
      window = Window(size = "PT1S", step = "PT1S", start = bucket.windowStart.toString(), end = end.toString()),
      version = 1,
    )
  }

  private fun newBucket(
    trade: TradePayload,
    windowStart: Instant,
  ) = Bucket(
    windowStart = windowStart,
    open = trade.p,
    high = trade.p,
    low = trade.p,
    close = trade.p,
    volume = trade.s,
    vwapNumerator = trade.p * trade.s,
    count = 1,
  )

  private fun updateBucket(
    bucket: Bucket,
    trade: TradePayload,
  ) {
    bucket.high = max(bucket.high, trade.p)
    bucket.low = min(bucket.low, trade.p)
    bucket.close = trade.p
    bucket.volume += trade.s
    bucket.vwapNumerator += trade.p * trade.s
    bucket.count += 1
  }
}
