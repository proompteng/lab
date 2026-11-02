package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class CryptoMarketFeatureClickhouseIntegrationTest {
  @Test
  fun `production feature schema and JDBC retain derived identity availability and native source references`() {
    val endpoint = System.getenv("BAYN_TEST_CLICKHOUSE_URL")
    assumeTrue(endpoint != null, "requires a guarded disposable ClickHouse service")
    val guard = requireNotNull(System.getenv("BAYN_TEST_CLICKHOUSE_GUARD_TOKEN"))
    require(guard.matches(Regex("[0-9a-f]{32}")))
    val path =
      generateSequence(Path.of("").toAbsolutePath()) { it.parent }
        .map { it.resolve("argocd/applications/torghut/clickhouse/intraday-bars-schema-job.yaml") }
        .first { Files.exists(it) }
    val ddl =
      requireNotNull(
        Regex("CREATE TABLE IF NOT EXISTS signal\\.crypto_market_features_v1 ON CLUSTER default[\\s\\S]+?;").find(Files.readString(path)),
      ).value.replace(" ON CLUSTER default", "").replace(Regex("ReplicatedReplacingMergeTree\\([\\s\\S]+?\\)"), "ReplacingMergeTree()")
    val fixture = CryptoFeatureTestData
    val start = Instant.now().minusSeconds(180 * 60).truncatedTo(ChronoUnit.MINUTES)
    val computed = System.currentTimeMillis()
    val result =
      (0..120).fold(CryptoFeatureTransition(CryptoFeatureState())) { previous, index ->
        advanceCryptoFeature(
          previous.state,
          assertNotNull(
            decodeCryptoFeatureBar(fixture.record(index, volume = "0.000000000123456789128", eventStart = start), fixture.source),
          ),
          computed,
          fixture.revision,
        )
      }
    val feature = assertNotNull(result.feature)
    val payload = Json { encodeDefaults = true }.encodeToString(CryptoMarketFeature.serializer(), feature)
    val row =
      decodeArchivedCryptoMarketFeature(ArchiveKafkaRecord("crypto-features", 2, 42, payload), fixture.source, "crypto-features", computed)
    DriverManager.getConnection("jdbc:clickhouse:$endpoint/default", "default", "").use { connection ->
      connection.createStatement().use { statement ->
        statement.executeQuery("SELECT toString(token) FROM bayn_ci_guard.endpoint_identity").use { response ->
          assertTrue(response.next())
          assertEquals(guard, response.getString(1))
          assertFalse(response.next())
        }
        statement.execute("CREATE DATABASE IF NOT EXISTS signal")
        repeat(2) { statement.execute(ddl) }
        try {
          connection.prepareStatement(cryptoMarketFeatureInsertSql()).use { prepared ->
            repeat(2) {
              cryptoMarketFeatureStatement().accept(prepared, row)
              prepared.addBatch()
              prepared.executeBatch()
            }
          }
          statement
            .executeQuery(
              "SELECT feature_id, location, symbol, toUnixTimestamp64Milli(window_start), toUnixTimestamp64Milli(window_end), " +
                "toUnixTimestamp64Milli(computed_at), toUnixTimestamp64Milli(archived_at), " +
                "source_topic, source_partition, source_offset, payload " +
                "FROM signal.crypto_market_features_v1 FINAL",
            ).use { response ->
              assertTrue(response.next())
              assertEquals(feature.featureId, response.getString(1))
              assertEquals("us", response.getString(2))
              assertEquals("BTC/USD", response.getString(3))
              assertEquals(feature.material.windowStartMs, response.getLong(4))
              assertEquals(feature.material.windowEndMs, response.getLong(5))
              assertEquals(computed, response.getLong(6))
              assertEquals(computed, response.getLong(7))
              assertEquals("crypto-features", response.getString(8))
              assertEquals(2, response.getInt(9))
              assertEquals(42L, response.getLong(10))
              assertEquals(payload, response.getString(11))
              assertEquals(
                "0.00000000370370367384",
                feature.material.priceWindow
                  ?.totalVolume,
              )
              assertFalse(response.next())
            }
        } finally {
          statement.execute("DROP TABLE signal.crypto_market_features_v1")
        }
      }
    }
  }
}
