package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ArchiveTimestampPrecisionIntegrationTest {
  @Test
  fun `production archive JDBC preserves exact timestamps alongside unknown legacy precision`() {
    val endpoint = System.getenv("BAYN_TEST_CLICKHOUSE_URL")
    assumeTrue(endpoint != null, "requires the guarded disposable ClickHouse CI service")
    val guard = requireNotNull(System.getenv("BAYN_TEST_CLICKHOUSE_GUARD_TOKEN"))
    require(guard.matches(Regex("[0-9a-f]{32}")))
    val schemaPath =
      generateSequence(Path.of("").toAbsolutePath()) { it.parent }
        .map { it.resolve("argocd/applications/torghut/clickhouse/intraday-bars-schema-job.yaml") }
        .first { Files.exists(it) }
    val schema = Files.readString(schemaPath)
    val createPrefix = "CREATE TABLE IF NOT EXISTS signal.intraday_bars_1m_v2 ON CLUSTER default"
    require(schema.contains(createPrefix))
    val columns = schema.substringAfter(createPrefix).substringBefore("ENGINE =")
    val migration =
      requireNotNull(Regex("ALTER TABLE signal\\.intraday_bars_1m_v2 ON CLUSTER default[\\s\\S]+?;").find(schema))
        .value.replace(" ON CLUSTER default", "")
    DriverManager.getConnection("jdbc:clickhouse:$endpoint/default", "default", "").use { connection ->
      connection.createStatement().use { statement ->
        statement.executeQuery("SELECT toString(token) FROM bayn_ci_guard.endpoint_identity").use { result ->
          assertTrue(result.next())
          assertEquals(guard, result.getString(1))
          assertEquals(false, result.next())
        }
        statement.execute("CREATE DATABASE IF NOT EXISTS signal")
        statement.execute(
          "CREATE TABLE signal.intraday_bars_1m_v2 $columns " +
            "ENGINE = ReplacingMergeTree(source_offset) PARTITION BY toYYYYMM(event_ts) " +
            "ORDER BY (universe_id, feed, symbol, event_ts, source_topic, source_partition, source_offset)",
        )
        try {
          statement.execute(
            "INSERT INTO signal.intraday_bars_1m_v2 (event_ts, ingest_ts, source_offset) " +
              "VALUES ('2026-10-01 13:30:00.123456789', '2026-10-01 13:31:00.321780322', 1)",
          )
          statement.execute(migration)
          statement.execute(migration)
          statement.executeQuery(
            "SELECT toString(event_ts), toString(ingest_ts), event_ts_exact, ingest_ts_exact " +
              "FROM signal.intraday_bars_1m_v2 WHERE source_offset = 1",
          ).use { result ->
            assertTrue(result.next())
            assertEquals("2026-10-01 13:30:00.123", result.getString(1))
            assertEquals("2026-10-01 13:31:00.321", result.getString(2))
            assertEquals(null, result.getObject(3))
            assertEquals(null, result.getObject(4))
          }
          val universe = ArchiveUniverse("archive-precision-v1", "a".repeat(64), setOf("SPY"))
          val topic = "archive-precision-bars"
          val routes = mapOf(topic to ArchiveRoute("sip", universe))
          val fractions = listOf(0, 1, 999_999, 1_000_000, 321_780_322, 999_999_999)
          fractions.forEachIndexed { index, nanos ->
            val prices =
              if (index % 2 == 0) {
                listOf(248.51, 248.605, 248.44, 248.44, 1311.0, Double.fromBits(0x406f1094face67d7L))
              } else {
                listOf(346.45, 346.55, 346.39, 346.44, 3562.0, Double.fromBits(0x4075a78811b1d92bL))
              }
            val eventTime = Instant.parse("2026-10-01T13:30:00Z").plusNanos(nanos.toLong())
            val ingestionTime = Instant.parse("2026-10-01T13:31:00Z").plusNanos(nanos.toLong())
            val envelope =
              Envelope(
                ingestTs = ingestionTime,
                eventTs = eventTime,
                feed = "sip",
                channel = "bars",
                symbol = "SPY",
                seq = 1,
                payload = AlpacaBarPayload(prices[0], prices[1], prices[2], prices[3], prices[4], prices[5], 2, eventTime.toString()),
                provider = "alpaca",
                marketSession = "regular",
                delayClass = "real_time_consolidated",
                version = 2,
              )
            val row = decodeArchiveBar(ArchiveKafkaRecord(topic, 0, index + 2L, Json.encodeToString(envelope)), routes)
            connection.prepareStatement(archiveBarInsertSql()).use { prepared ->
              archiveBarStatement().accept(prepared, row)
              prepared.addBatch()
              prepared.executeBatch()
            }
            statement.executeQuery(
              "SELECT toUnixTimestamp64Nano(event_ts_exact), toUnixTimestamp64Nano(ingest_ts_exact), " +
                "open, high, low, close, volume, vwap, toString(vwap) " +
                "FROM signal.intraday_bars_1m_v2 WHERE source_topic = '$topic' AND source_offset = ${index + 2}",
            ).use { result ->
              assertTrue(result.next())
              assertEquals(1_790_861_400_000_000_000L + nanos, result.getLong(1))
              assertEquals(1_790_861_460_000_000_000L + nanos, result.getLong(2))
              prices.forEachIndexed { field, expected ->
                assertEquals(expected.toBits(), result.getDouble(field + 3).toBits(), "binary64 field $field")
              }
              assertEquals(prices[5].toBits(), result.getString(9).toDouble().toBits(), "archive VWAP text")
              assertEquals(false, result.next())
            }
          }
        } finally {
          statement.execute("DROP TABLE signal.intraday_bars_1m_v2")
        }
      }
    }
  }
}
