package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.SeqTracker
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class HyperliquidMapperTest {
  private val json = Json { ignoreUnknownKeys = true }
  private val config =
    HyperliquidConfig.fromEnv(
      mapOf(
        "KAFKA_SASL_PASSWORD" to "secret",
        "CLICKHOUSE_ENABLED" to "false",
      ),
    )
  private val market =
    HyperliquidMarket(
      marketId = HyperliquidMarketIds.perp("BTC", null),
      marketType = HyperliquidMarketType.PERP,
      coin = "BTC",
      subscriptionCoin = "BTC",
      dex = null,
      spotIndex = null,
      payload = JsonPrimitive("BTC"),
    )
  private val mapper = HyperliquidMapper(config, listOf(market), SeqTracker(), json)

  @Test
  fun `maps websocket trades to normalized topic envelopes`() {
    val records =
      mapper.websocketRecords(
        """{"channel":"trades","data":[{"coin":"BTC","side":"B","px":"65000","sz":"0.1","hash":"0x1","time":1710000000000,"tid":123,"users":["0x0","0x1"]}]}""",
      )

    assertEquals(1, records.size)
    val record = records.single()
    assertEquals("torghut.hyperliquid.trades.v1", record.topic)
    assertEquals("hl:perp:default:BTC", record.key)
    assertEquals("trades", record.envelope.channel)
    assertEquals("2024-03-09T16:00:00Z", record.envelope.eventTs)
    assertEquals("BTC", record.envelope.coin)
  }

  @Test
  fun `maps candle payload with interval and close timestamp`() {
    val records =
      mapper.websocketRecords(
        """{"channel":"candle","data":{"t":1710000000000,"T":1710000059999,"s":"BTC","i":"1m","o":1,"c":2,"h":3,"l":1,"v":10,"n":2}}""",
      )

    val record = records.single()
    assertEquals("torghut.hyperliquid.candles.v1", record.topic)
    assertEquals("candle", record.envelope.channel)
    assertEquals("2024-03-09T16:00:59.999Z", record.envelope.eventTs)
    assertNotNull(record.envelope.payload.jsonObject["i"])
  }

  @Test
  fun `ignores pong and subscription acknowledgements`() {
    assertEquals(emptyList(), mapper.websocketRecords("""{"channel":"pong"}"""))
    assertEquals(
      emptyList(),
      mapper.websocketRecords("""{"channel":"subscriptionResponse","data":{"type":"trades","coin":"BTC"}}"""),
    )
  }
}
