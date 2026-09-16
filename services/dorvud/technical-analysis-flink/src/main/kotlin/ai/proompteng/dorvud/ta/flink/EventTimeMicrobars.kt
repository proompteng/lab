package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import kotlinx.serialization.json.Json
import org.apache.flink.api.common.functions.OpenContext
import org.apache.flink.api.common.functions.RichFlatMapFunction
import org.apache.flink.metrics.Counter
import org.apache.flink.util.Collector
import java.io.Serializable
import java.time.Instant

internal data class RecordedTrade(
  val envelope: Envelope<TradePayload>,
  val topic: String,
  val partition: Int,
  val offset: Long,
) : Serializable

internal class ParseRecordedTrade : RichFlatMapFunction<ArchiveKafkaRecord, RecordedTrade>() {
  private lateinit var rejected: Counter

  @Transient private lateinit var json: Json

  override fun open(openContext: OpenContext) {
    rejected = runtimeContext.metricGroup.counter("trades_parse_failures")
    json = Json { ignoreUnknownKeys = true }
  }

  override fun flatMap(
    value: ArchiveKafkaRecord,
    out: Collector<RecordedTrade>,
  ) {
    val envelope =
      try {
        json.decodeFromString(Envelope.serializer(TradePayload.serializer()), value.value)
      } catch (_: IllegalArgumentException) {
        rejected.inc()
        return
      }
    val trade = envelope.payload
    if (!trade.p.isFinite() || trade.p <= 0 || !trade.s.isFinite() || trade.s <= 0 || envelope.eventTs != trade.t) {
      rejected.inc()
      return
    }
    out.collect(RecordedTrade(envelope, value.topic, value.partition, value.offset))
  }
}

internal data class EventTimeTradeBucket(
  val trades: MutableList<RecordedTrade> = ArrayList(),
) : Serializable {
  @Transient private var sourceIndex: MutableMap<TradeSourceKey, RecordedTrade>? = null

  fun add(incoming: RecordedTrade): EventTimeTradeBucket {
    val index = sourceIndex ?: trades.associateByTo(HashMap()) { it.sourceKey() }.also { sourceIndex = it }
    val key = incoming.sourceKey()
    val existing = index[key]
    if (existing != null) {
      require(existing == incoming) { "conflicting immutable trade source record" }
      return this
    }
    require(
      trades.isEmpty() || trades
        .first()
        .envelope.payload.t.epochSecond == incoming.envelope.payload.t.epochSecond,
    ) {
      "mixed microbar windows"
    }
    trades.add(incoming)
    index[key] = incoming
    return this
  }

  fun payload(): MicroBarPayload {
    require(trades.isNotEmpty()) { "empty microbar bucket" }
    val ordered = trades.sortedWith(compareBy({ it.envelope.payload.t }, { it.topic }, { it.partition }, { it.offset }))
    val values = ordered.map { it.envelope.payload }
    val volume = values.sumOf { it.s }
    return MicroBarPayload(
      o = values.first().p,
      h = values.maxOf { it.p },
      l = values.minOf { it.p },
      c = values.last().p,
      v = volume,
      vwap = values.sumOf { it.p * it.s } / volume,
      count = values.size.toLong(),
      t = Instant.ofEpochSecond(values.first().t.epochSecond + 1),
    )
  }
}

private data class TradeSourceKey(
  val topic: String,
  val partition: Int,
  val offset: Long,
)

private fun RecordedTrade.sourceKey() = TradeSourceKey(topic, partition, offset)
