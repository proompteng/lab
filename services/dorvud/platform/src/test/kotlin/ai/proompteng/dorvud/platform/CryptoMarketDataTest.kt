package ai.proompteng.dorvud.platform

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class CryptoMarketDataTest {
  private val payloads = (Json.parseToJsonElement(File("../fixtures/alpaca-crypto-v1.json").readText()) as JsonArray).map { it.jsonObject }

  @Test
  fun `native crypto shapes retain exact numbers ids timestamps and book updates`() {
    val events = payloads.map(::decodeCryptoMarketData)
    assertEquals(payloads, events.map { it.payload })
    assertEquals(payloads, events.map { Json.parseToJsonElement(Json.encodeToString(JsonElement.serializer(), it.payload)) })
    assertEquals(CryptoChannel.entries.toSet(), events.map { it.channel }.toSet())
    assertEquals(
      "18446744073709551614",
      events
        .first()
        .payload
        .getValue("i")
        .toString(),
    )
    assertEquals("0.123456789123456789", events[1].payload.getValue("bs").toString())
    assertEquals(123456789, events.first().eventTs.nano)
    assertEquals("true", events[5].payload.getValue("r").toString())
    assertEquals(payloads[6], events[6].payload)
  }

  @Test
  fun `rejects malformed native trade identities and quantities`() {
    for ((field, invalid) in listOf(
      "S" to JsonPrimitive("BTCUSD"),
      "i" to JsonPrimitive("18446744073709551614"),
      "i" to JsonPrimitive(-1),
      "i" to JsonPrimitive(1.5),
      "tks" to JsonPrimitive("unknown"),
      "s" to JsonPrimitive(-0.01),
      "p" to JsonPrimitive("67123.1"),
      "t" to JsonPrimitive("invalid"),
    )) {
      assertFails(field) { decodeCryptoMarketData(JsonObject(payloads.first() + (field to invalid))) }
    }
    assertFails { decodeCryptoMarketData(JsonObject(payloads.first() - "tks")) }
    assertFails { decodeCryptoMarketData(JsonObject(payloads[5] + ("r" to JsonPrimitive("true")))) }
  }
}
