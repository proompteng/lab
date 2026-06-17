package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.SeqTracker
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.Instant

class HyperliquidMapper(
  private val config: HyperliquidConfig,
  markets: List<HyperliquidMarket>,
  private val seqTracker: SeqTracker,
  private val json: Json,
  private val now: () -> Instant = { Instant.now() },
) {
  private val bySubscriptionCoin = markets.associateBy { it.subscriptionCoin }
  private val byCoin = markets.associateBy { it.coin }

  fun marketRecords(markets: List<HyperliquidMarket>): List<RoutedEnvelope> =
    markets.map { market ->
      val timestamp = now().toString()
      val payload =
        buildJsonObject {
          put("market_id", market.marketId)
          put("market_type", market.marketType.wireValue)
          put("coin", market.coin)
          put("subscription_coin", market.subscriptionCoin)
          market.dex?.let { put("dex", it) }
          market.spotIndex?.let { put("spot_index", it) }
          put("raw", market.payload)
        }
      RoutedEnvelope(
        topic = config.topics.markets,
        key = market.marketId,
        envelope =
          envelope(
            channel = "market",
            symbol = market.coin,
            market = market,
            payload = payload,
            eventTs = timestamp,
            source = "rest",
          ),
      )
    }

  fun rawRecord(raw: String): RoutedEnvelope {
    val timestamp = now().toString()
    return RoutedEnvelope(
      topic = config.topics.raw,
      key = "raw",
      envelope =
        HyperliquidEnvelope(
          ingestTs = timestamp,
          eventTs = timestamp,
          network = config.network,
          feed = "ws",
          channel = "raw",
          symbol = "hyperliquid",
          marketType = null,
          marketId = null,
          dex = null,
          coin = null,
          spotIndex = null,
          seq = seqTracker.next("raw"),
          source = "ws",
          payload = JsonPrimitive(raw),
        ),
    )
  }

  fun websocketRecords(raw: String): List<RoutedEnvelope> {
    val root = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return emptyList()
    val channel = root["channel"]?.jsonPrimitive?.contentOrNull ?: return emptyList()
    if (channel == "pong" || channel == "subscriptionResponse") return emptyList()
    val data = root["data"] ?: return emptyList()

    return when (channel) {
      "trades" -> data.asArray().flatMap { trade -> marketRecordFromPayload(channel, trade, config.topics.trades, "time") }
      "l2Book" -> marketRecordFromPayload(channel, data, config.topics.booksL2, "time")
      "bbo" -> marketRecordFromPayload(channel, data, config.topics.bbo, "time")
      "candle" -> marketRecordFromPayload(channel, data, config.topics.candles, "T")
      "activeAssetCtx" -> marketRecordFromPayload(channel, data, config.topics.assetCtx, "time")
      "allDexsAssetCtxs" -> listOf(globalRecord(channel, data, config.topics.assetCtx))
      "allMids" -> listOf(globalRecord(channel, data, config.topics.assetCtx))
      else -> listOf(globalRecord(channel, data, config.topics.status))
    }
  }

  fun dedupKey(record: RoutedEnvelope): String {
    val payload = record.envelope.payload
    if (payload !is JsonObject) return "${record.envelope.channel}:${record.key}:${record.envelope.seq}"
    return when (record.envelope.channel) {
      "trades" ->
        listOf(
          record.envelope.channel,
          record.envelope.coin,
          payload["time"]?.jsonPrimitive?.contentOrNull,
          payload["tid"]?.jsonPrimitive?.contentOrNull,
        ).joinToString(":")
      "l2Book", "bbo", "activeAssetCtx" ->
        listOf(record.envelope.channel, record.envelope.marketId, payload["time"]?.jsonPrimitive?.contentOrNull)
          .joinToString(":")
      "candle" ->
        listOf(
          record.envelope.channel,
          record.envelope.marketId,
          payload["i"]?.jsonPrimitive?.contentOrNull,
          payload["t"]?.jsonPrimitive?.contentOrNull,
          payload["T"]?.jsonPrimitive?.contentOrNull,
        ).joinToString(":")
      else -> "${record.envelope.channel}:${record.key}:${record.envelope.eventTs}"
    }
  }

  private fun marketRecordFromPayload(
    channel: String,
    payload: JsonElement,
    topic: String,
    eventTimeField: String,
  ): List<RoutedEnvelope> {
    val payloadObject = payload as? JsonObject ?: return emptyList()
    val coin = payloadObject["coin"]?.jsonPrimitive?.contentOrNull ?: payloadObject["s"]?.jsonPrimitive?.contentOrNull
    val market = coin?.let { bySubscriptionCoin[it] ?: byCoin[it] }
    val key = market?.marketId ?: coin ?: channel
    return listOf(
      RoutedEnvelope(
        topic = topic,
        key = key,
        envelope =
          envelope(
            channel = channel,
            symbol = coin ?: channel,
            market = market,
            payload = payload,
            eventTs = eventTs(payloadObject[eventTimeField]),
            source = "ws",
          ),
      ),
    )
  }

  private fun globalRecord(
    channel: String,
    payload: JsonElement,
    topic: String,
  ): RoutedEnvelope {
    val timestamp = now().toString()
    return RoutedEnvelope(
      topic = topic,
      key = channel,
      envelope =
        HyperliquidEnvelope(
          ingestTs = timestamp,
          eventTs = timestamp,
          network = config.network,
          feed = "ws",
          channel = channel,
          symbol = channel,
          marketType = null,
          marketId = null,
          dex = null,
          coin = null,
          spotIndex = null,
          seq = seqTracker.next(channel),
          source = "ws",
          payload = payload,
        ),
    )
  }

  private fun envelope(
    channel: String,
    symbol: String,
    market: HyperliquidMarket?,
    payload: JsonElement,
    eventTs: String,
    source: String,
  ): HyperliquidEnvelope =
    HyperliquidEnvelope(
      ingestTs = now().toString(),
      eventTs = eventTs,
      network = config.network,
      feed = "hyperliquid-${config.network}",
      channel = channel,
      symbol = symbol,
      marketType = market?.marketType?.wireValue,
      marketId = market?.marketId,
      dex = market?.dex,
      coin = market?.coin ?: symbol.takeIf { it != channel },
      spotIndex = market?.spotIndex,
      seq = seqTracker.next(market?.marketId ?: symbol),
      source = source,
      payload = payload,
    )

  private fun eventTs(value: JsonElement?): String {
    val millis = value?.jsonPrimitive?.contentOrNull?.toLongOrNull()
    return if (millis == null) now().toString() else Instant.ofEpochMilli(millis).toString()
  }

  private fun JsonElement.asArray(): List<JsonElement> =
    when (this) {
      is JsonArray -> jsonArray
      else -> listOf(this)
    }
}
