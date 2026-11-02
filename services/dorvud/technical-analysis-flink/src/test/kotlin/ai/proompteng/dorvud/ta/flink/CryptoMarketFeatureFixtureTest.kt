package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class CryptoMarketFeatureFixtureTest {
  @Test
  fun `publish a shared native crypto source and feature fixture across midnight`() {
    for ((symbol, partition, fullName) in listOf(
      Triple("BTC/USD", 1, "crypto-continuous-v2.json"),
      Triple("ETH/USD", 2, "crypto-eth-continuous-v2.json"),
      Triple("SOL/USD", 3, "crypto-sol-continuous-v2.json"),
    )) {
      for (count in listOf(1, 61)) {
        val name = if (count == 1) fullName.replace("-v2.json", "-first-minute-v2.json") else fullName
        val source = CryptoFeatureTestData.source.copy(topic = "bayn.market-data.crypto.v1", symbols = setOf(symbol))
        val start = java.time.Instant.parse(if (count == 1) "2026-10-11T00:00:00Z" else "2026-10-10T23:00:00Z")
        val records =
          (0 until count).map {
            CryptoFeatureTestData
              .record(
                it,
                price = "100.123456789",
                volume = "0.000000001",
                vwap = "100.123456789",
                eventStart = start,
              ).let {
                it.copy(topic = source.topic, partition = partition, value = it.value.replace("BTC/USD", symbol))
              }
          }
        var transition = CryptoFeatureTransition(CryptoFeatureState())
        for (record in records) {
          val bar = assertNotNull(decodeCryptoFeatureBar(record, source))
          transition = advanceCryptoFeature(transition.state, bar, bar.ingestionTime.toEpochMilli() + 2_000, CryptoFeatureTestData.revision)
        }
        val feature = assertNotNull(transition.feature)
        assertEquals(
          "2026-10-11T00:01:00Z",
          java.time.Instant
            .ofEpochMilli(feature.material.windowEndMs)
            .toString(),
        )
        assertEquals(count, feature.material.inputs.size)
        assertEquals(
          if (count == 1) "0.000000001" else "0.00000003",
          feature.material.priceWindow
            ?.totalVolume,
        )
        val document =
          buildJsonObject {
            put(
              "records",
              JsonArray(
                records.map { record ->
                  buildJsonObject {
                    put("topic", record.topic)
                    put("partition", record.partition)
                    put("offset", record.offset.toString())
                    put("value", record.value)
                  }
                },
              ),
            )
            put("feature", cryptoFeatureJson.encodeToJsonElement(CryptoMarketFeature.serializer(), feature))
          }
        val fixture = File("../../bayn/src/market-data/features/fixtures/$name")
        if (System.getProperty("writeMarketFeatureFixture") == "true") {
          fixture.parentFile.mkdirs()
          fixture.writeText(Json { prettyPrint = true }.encodeToString(JsonElement.serializer(), document) + "\n")
        }
        val retained = Json.parseToJsonElement(fixture.readText())
        assertEquals(retained, document)
      }
    }
  }
}
