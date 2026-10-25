package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.CRYPTO_DELAY_CLASS
import ai.proompteng.dorvud.platform.CRYPTO_SESSION
import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.decodeCryptoMarketData
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CryptoMarketDataClickhouseIntegrationTest {
  @Test
  fun `production crypto JDBC and schema preserve exact events and deduplicate retries`() {
    val endpoint = System.getenv("BAYN_TEST_CLICKHOUSE_URL")
    assumeTrue(endpoint != null, "requires a guarded disposable ClickHouse service")
    val guard = requireNotNull(System.getenv("BAYN_TEST_CLICKHOUSE_GUARD_TOKEN"))
    require(guard.matches(Regex("[0-9a-f]{32}")))
    val schemaPath =
      generateSequence(Path.of("").toAbsolutePath()) { it.parent }
        .map { it.resolve("argocd/applications/torghut/clickhouse/intraday-bars-schema-job.yaml") }
        .first { Files.exists(it) }
    val schema = Files.readString(schemaPath)
    val ddl =
      requireNotNull(Regex("CREATE TABLE IF NOT EXISTS signal\\.crypto_market_events_v1 ON CLUSTER default[\\s\\S]+?;").find(schema))
        .value
        .replace(" ON CLUSTER default", "")
        .replace(Regex("ReplicatedReplacingMergeTree\\([\\s\\S]+?\\)"), "ReplacingMergeTree()")
    val fixtureDate =
      Instant
        .now()
        .atZone(ZoneOffset.UTC)
        .toLocalDate()
        .toString()
    val payloads =
      (Json.parseToJsonElement(File("../fixtures/alpaca-crypto-v1.json").readText()) as JsonArray).map {
        val payload = it.jsonObject
        JsonObject(
          payload + (
            "t" to
              JsonPrimitive(
                fixtureDate +
                  payload
                    .getValue("t")
                    .jsonPrimitive.content
                    .substring(10),
              )
          ),
        )
      }
    val crypto = CryptoArchiveConfig("crypto-integration", "us", setOf("BTC/USD"))
    val formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSSSSSSSS").withZone(ZoneOffset.UTC)
    val archived =
      payloads.mapIndexed { index, payload ->
        val event = decodeCryptoMarketData(payload.jsonObject)
        val envelope: Envelope<JsonElement> =
          Envelope(
            ingestTs = Instant.parse(fixtureDate + "T02:04:01.987654321Z"),
            eventTs = event.eventTs,
            feed = "us",
            channel = event.channel.subscription,
            symbol = event.symbol,
            seq = index + 1L,
            payload = event.payload,
            provider = "alpaca",
            marketSession = CRYPTO_SESSION,
            delayClass = CRYPTO_DELAY_CLASS,
            version = 2,
          )
        decodeArchivedCryptoMarketData(
          ArchiveKafkaRecord(crypto.topic, 1, index + 100L, Json.encodeToString(Envelope.serializer(JsonElement.serializer()), envelope)),
          crypto,
        )
      }
    DriverManager.getConnection("jdbc:clickhouse:$endpoint/default", "default", "").use { connection ->
      connection.createStatement().use { statement ->
        statement.executeQuery("SELECT toString(token) FROM bayn_ci_guard.endpoint_identity").use { result ->
          assertTrue(result.next())
          assertEquals(guard, result.getString(1))
          assertFalse(result.next())
        }
        statement.execute("CREATE DATABASE IF NOT EXISTS signal")
        repeat(2) { statement.execute(ddl) }
        try {
          connection.prepareStatement(cryptoMarketDataInsertSql()).use { prepared ->
            repeat(2) {
              archived.forEach { event ->
                cryptoMarketDataStatement().accept(prepared, event)
                prepared.addBatch()
              }
              prepared.executeBatch()
            }
          }
          statement
            .executeQuery(
              "SELECT toString(event_ts), toString(ingest_ts), payload, source_partition, source_offset, sequence " +
                "FROM signal.crypto_market_events_v1 FINAL ORDER BY source_offset",
            ).use { result ->
              archived.forEachIndexed { index, event ->
                assertTrue(result.next())
                assertEquals(formatter.format(Instant.parse(event.eventTs)), result.getString(1))
                assertEquals(formatter.format(Instant.parse(event.ingestTs)), result.getString(2))
                assertEquals(payloads[index], Json.parseToJsonElement(result.getString(3)))
                assertEquals(1, result.getInt(4))
                assertEquals(index + 100L, result.getLong(5))
                assertEquals(index + 1L, result.getLong(6))
              }
              assertFalse(result.next())
            }
        } finally {
          statement.execute("DROP TABLE signal.crypto_market_events_v1")
        }
      }
    }
  }
}
