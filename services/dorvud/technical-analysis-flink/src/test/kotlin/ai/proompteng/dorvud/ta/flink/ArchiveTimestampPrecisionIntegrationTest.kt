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
    val migrations =
      Regex("ALTER TABLE signal\\.intraday_bars_1m_v2 ON CLUSTER default[\\s\\S]+?;")
        .findAll(schema)
        .map { it.value.replace(" ON CLUSTER default", "") }
        .toList()
    require(migrations.isNotEmpty())
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
        var verified = false
        try {
          statement.execute(
            "INSERT INTO signal.intraday_bars_1m_v2 (event_ts, ingest_ts, source_offset, vwap) " +
              "VALUES ('2026-10-01 13:30:00.123456789', '2026-10-01 13:31:00.321780322', 1, " +
              "reinterpretAsFloat64(toInt64(${0x406f1094face67d8L})))",
          )
          repeat(2) { migrations.forEach { migration -> statement.execute(migration) } }
          statement
            .executeQuery(
              "SELECT toString(event_ts), toString(ingest_ts), event_ts_exact, ingest_ts_exact, reinterpretAsUInt64(vwap) " +
                "FROM signal.intraday_bars_1m_v2 WHERE source_offset = 1",
            ).use { result ->
              assertTrue(result.next())
              assertEquals("2026-10-01 13:30:00.123", result.getString(1))
              assertEquals("2026-10-01 13:31:00.321", result.getString(2))
              assertEquals(null, result.getObject(3))
              assertEquals(null, result.getObject(4))
              assertEquals(0x406f1094face67d8L, java.lang.Long.parseUnsignedLong(result.getString(5)))
            }
          statement
            .executeQuery(
              "SELECT count() FROM system.mutations WHERE database = 'signal' AND table = 'intraday_bars_1m_v2'",
            ).use { result ->
              assertTrue(result.next())
              assertEquals(0L, result.getLong(1))
            }
          statement
            .executeQuery(
              "SELECT toFloat64OrZero(extract(create_table_query, " +
                "'ratio_of_defaults_for_sparse_serialization = ([0-9.eE+-]+)')) " +
                "FROM system.tables WHERE database = 'signal' AND name = 'intraday_bars_1m_v2'",
            ).use { result ->
              assertTrue(result.next())
              assertEquals(1.0, result.getDouble(1))
            }
          val universe = ArchiveUniverse("archive-precision-v1", "a".repeat(64), setOf("SPY"))
          val topic = "archive-precision-bars"
          val routes = mapOf(topic to ArchiveRoute("sip", universe))
          val fractions = listOf(0, 1, 999_999, 1_000_000, 321_780_322, 999_999_999)
          val numericMismatches = mutableListOf<String>()
          val samples =
            listOf(
              listOf(248.51, 248.605, 248.44, 248.44, 1311.0, Double.fromBits(0x406f1094face67d7L)),
              listOf(346.45, 346.55, 346.39, 346.44, 3562.0, Double.fromBits(0x4075a78811b1d92bL)),
              List(6) { Double.MIN_VALUE },
              List(6) { Double.MAX_VALUE },
              listOf(1.0, 1.0, 1.0, 1.0, 0.0, 1.0),
              listOf(1.0, 1.0, 1.0, 1.0, -0.0, 1.0),
              listOf(
                Math.nextDown(1.0),
                Math.nextUp(1.0),
                Math.nextDown(1.0),
                1.0,
                java.lang.Double.MIN_NORMAL,
                Math.nextUp(1.0),
              ),
              List(6) { 1.0 },
            )
          samples.forEachIndexed { index, prices ->
            val nanos = fractions[index % fractions.size]
            val vwap = if (index == samples.lastIndex) null else prices[5]
            val eventTime = Instant.parse("2026-10-01T13:30:00Z").plusSeconds(index * 60L).plusNanos(nanos.toLong())
            val ingestionTime = Instant.parse("2026-10-01T13:31:00Z").plusSeconds(index * 60L).plusNanos(nanos.toLong())
            val envelope =
              Envelope(
                ingestTs = ingestionTime,
                eventTs = eventTime,
                feed = "sip",
                channel = "bars",
                symbol = "SPY",
                seq = 1,
                payload = AlpacaBarPayload(prices[0], prices[1], prices[2], prices[3], prices[4], vwap, 2, eventTime.toString()),
                provider = "alpaca",
                marketSession = "regular",
                delayClass = "real_time_consolidated",
                version = 2,
              )
            val row = decodeArchiveBar(ArchiveKafkaRecord(topic, 0, index + 2L, Json.encodeToString(envelope)), routes)
            assertEquals(prices[4].toRawBits(), row.volume.toRawBits(), "decoded volume")
            connection.prepareStatement(archiveBarInsertSql()).use { prepared ->
              archiveBarStatement().accept(prepared, row)
              prepared.addBatch()
              prepared.executeBatch()
            }
            statement
              .executeQuery(
                "SELECT toUnixTimestamp64Nano(event_ts_exact), toUnixTimestamp64Nano(ingest_ts_exact), " +
                  "open, high, low, close, volume, vwap, toString(vwap), " +
                  "reinterpretAsUInt64(open), reinterpretAsUInt64(high), reinterpretAsUInt64(low), " +
                  "reinterpretAsUInt64(close), reinterpretAsUInt64(volume), reinterpretAsUInt64(vwap) " +
                  "FROM signal.intraday_bars_1m_v2 WHERE source_topic = '$topic' AND source_offset = ${index + 2}",
              ).use { result ->
                assertTrue(result.next())
                assertEquals(1_790_861_400_000_000_000L + index * 60_000_000_000L + nanos, result.getLong(1))
                assertEquals(1_790_861_460_000_000_000L + index * 60_000_000_000L + nanos, result.getLong(2))
                (prices.take(5) + vwap).forEachIndexed { field, expected ->
                  if (expected == null) {
                    assertEquals(null, result.getObject(field + 3))
                    assertEquals(null, result.getObject(field + 10))
                  } else {
                    val actual = result.getDouble(field + 3).toBits()
                    val stored = java.lang.Long.parseUnsignedLong(result.getString(field + 10))
                    if (expected.toBits() != actual || expected.toBits() != stored) {
                      numericMismatches.add(
                        "row=$index field=$field expected=${expected.toBits().toString(16)} " +
                          "stored=${stored.toString(16)} read=${actual.toString(16)}",
                      )
                    }
                  }
                }
                if (vwap == null) {
                  assertEquals(null, result.getString(9))
                } else if (vwap.toBits() != result.getString(9).toDouble().toBits()) {
                  numericMismatches.add("row=$index VWAP text=${result.getString(9)} expected=$vwap")
                }
                assertEquals(false, result.next())
              }
          }
          assertEquals(emptyList(), numericMismatches, "JDBC binary64 parity")
          println("Archive serialization footprint: ${compareSerializationSize(statement)}")
          verified = true
        } finally {
          if (!verified || System.getenv("BAYN_TEST_JDBC_RETAIN_ARCHIVE") != "true") {
            statement.execute("DROP TABLE signal.intraday_bars_1m_v2")
          }
        }
      }
    }
  }

  private fun compareSerializationSize(statement: java.sql.Statement): List<String> {
    val costs = mutableListOf<String>()
    for (legacy in listOf(false, true)) {
      for (defaults in listOf(false, true)) {
        for (ratio in listOf("0.9375", "1")) {
          val table = "signal.archive_precision_size_${if (ratio == "1") "full" else "sparse"}"
          statement.execute(
            "CREATE TABLE $table AS signal.intraday_bars_1m_v2 ENGINE = ReplacingMergeTree(source_offset) " +
              "PARTITION BY toYYYYMM(event_ts) " +
              "ORDER BY (universe_id, feed, symbol, event_ts, source_topic, source_partition, source_offset) " +
              "SETTINGS ratio_of_defaults_for_sparse_serialization = $ratio",
          )
          try {
            val event = "1790861400000 + intDiv(number, 16) * 60000"
            val exactEvent = if (legacy) "NULL" else "fromUnixTimestamp64Nano(toInt64(($event) * 1000000))"
            val exactIngest = if (legacy) "NULL" else "fromUnixTimestamp64Nano(toInt64(($event) * 1000000 + 60321780322))"
            val volume =
              if (defaults) {
                "reinterpretAsFloat64(if(number % 2 = 0, toInt64('-9223372036854775808'), toInt64(0)))"
              } else {
                "toFloat64(1000 + number % 31)"
              }
            val vwap = if (defaults) "NULL" else "reinterpretAsFloat64(toInt64(${248.518186.toRawBits()}))"
            val trades = if (defaults) "NULL" else "toUInt64(21)"
            statement.execute(
              "INSERT INTO $table " +
                "SELECT 'alpaca', 'archive-size-v1', repeat('a', 64), 'sip', 'bars', 'regular', " +
                "'real_time_consolidated', concat('S', toString(number % 16)), " +
                "fromUnixTimestamp64Milli(toInt64($event)), fromUnixTimestamp64Milli(toInt64(($event) + 60321)), " +
                "'archive-size', toUInt32(${if (defaults) "0" else "number % 3"}), number, toUInt8(1), " +
                "reinterpretAsFloat64(toInt64(${248.51.toRawBits()})), " +
                "reinterpretAsFloat64(toInt64(${248.605.toRawBits()})), " +
                "reinterpretAsFloat64(toInt64(${248.44.toRawBits()})), " +
                "reinterpretAsFloat64(toInt64(${248.44.toRawBits()})), " +
                "$volume, $vwap, $trades, toUInt32(1), $exactEvent, $exactIngest FROM numbers(4096)",
            )
            val mismatches =
              statement
                .executeQuery(
                  "SELECT countIf(" +
                    "reinterpretAsUInt64(open) != ${248.51.toRawBits()} OR " +
                    "reinterpretAsUInt64(high) != ${248.605.toRawBits()} OR " +
                    "reinterpretAsUInt64(low) != ${248.44.toRawBits()} OR " +
                    "reinterpretAsUInt64(close) != ${248.44.toRawBits()} OR " +
                    "reinterpretAsUInt64(volume) != reinterpretAsUInt64(${volume.replace("number", "source_offset")}) OR " +
                    (if (defaults) "isNotNull(vwap)" else "reinterpretAsUInt64(vwap) != ${248.518186.toRawBits()}") +
                    ") FROM $table",
                ).use { result ->
                  assertTrue(result.next())
                  result.getLong(1)
                }
            if (ratio == "1") assertEquals(0L, mismatches)
            statement
              .executeQuery(
                "SELECT sum(rows), sum(data_compressed_bytes), sum(data_uncompressed_bytes), sum(bytes_on_disk) " +
                  "FROM system.parts WHERE database = 'signal' AND table = '${table.substringAfter('.')}' AND active",
              ).use { result ->
                assertTrue(result.next())
                assertEquals(4096L, result.getLong(1))
                costs.add(
                  "legacy=$legacy defaults=$defaults ratio=$ratio rows=${result.getLong(1)} " +
                    "compressed=${result.getLong(2)} uncompressed=${result.getLong(3)} disk=${result.getLong(4)} " +
                    "identityMismatches=$mismatches",
                )
              }
          } finally {
            statement.execute("DROP TABLE $table")
          }
        }
      }
    }
    return costs
  }
}
