package ai.proompteng.dorvud.hyperliquid

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class KafkaLineage(
  val topic: String,
  val partition: Int,
  val offset: Long,
)

internal fun clickHouseRowFor(
  json: Json,
  record: RoutedEnvelope,
  lineage: KafkaLineage? = null,
): JsonObject =
  buildJsonObject {
    val env = record.envelope
    put("ingest_ts", env.ingestTs)
    put("event_ts", env.eventTs)
    put("provider", env.provider)
    put("network", env.network)
    put("feed", env.feed)
    put("channel", env.channel)
    put("symbol", env.symbol)
    env.marketType?.let { put("market_type", it) }
    env.marketId?.let { put("market_id", it) }
    env.dex?.let { put("dex", it) }
    env.coin?.let { put("coin", it) }
    env.spotIndex?.let { put("spot_index", it) }
    put("seq", env.seq)
    put("is_final", env.isFinal)
    put("source", env.source)
    put("version", env.version)
    put("payload", json.encodeToString(env.payload))
    lineage?.let {
      put("kafka_topic", it.topic)
      put("kafka_partition", it.partition)
      put("kafka_offset", it.offset)
    }
  }
