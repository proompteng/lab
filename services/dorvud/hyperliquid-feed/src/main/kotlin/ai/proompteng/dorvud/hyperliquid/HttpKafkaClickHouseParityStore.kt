package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.request.basicAuth
import io.ktor.client.request.post
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.net.URLEncoder

internal class HttpKafkaClickHouseParityStore(
  private val config: ClickHouseConfig,
  private val httpClient: HttpClient,
  private val json: Json,
) : KafkaClickHouseParityStore {
  override fun rangeStats(snapshot: KafkaPartitionSnapshot): KafkaClickHouseLineageRangeStats {
    val query =
      """
      SELECT
        count() AS rows,
        uniqExact(kafka_offset) AS distinct_offsets,
        minOrNull(kafka_offset) AS first_offset,
        maxOrNull(kafka_offset) AS last_offset
      FROM ${identifier(config.database)}.${identifier(snapshot.table)}
      WHERE kafka_topic = ${sqlString(snapshot.topic)}
        AND kafka_partition = ${snapshot.partition}
        AND kafka_offset >= ${snapshot.beginningOffset}
        AND kafka_offset < ${snapshot.highWatermarkExclusive}
      FORMAT JSONEachRow
      """.trimIndent()
    val row = json.decodeFromString<JsonObject>(execute(query).trim())
    return KafkaClickHouseLineageRangeStats(
      rows = row.getValue("rows").jsonPrimitive.long,
      distinctOffsets = row.getValue("distinct_offsets").jsonPrimitive.long,
      firstOffset = row.longOrNull("first_offset"),
      lastOffset = row.longOrNull("last_offset"),
    )
  }

  override fun offsetCounts(
    snapshot: KafkaPartitionSnapshot,
    offsets: List<Long>,
  ): Map<Long, Long> {
    if (offsets.isEmpty()) return emptyMap()
    val query =
      """
      SELECT kafka_offset, count() AS rows
      FROM ${identifier(config.database)}.${identifier(snapshot.table)}
      WHERE kafka_topic = ${sqlString(snapshot.topic)}
        AND kafka_partition = ${snapshot.partition}
        AND kafka_offset IN (${offsets.joinToString(",")})
      GROUP BY kafka_offset
      FORMAT JSONEachRow
      """.trimIndent()
    return execute(query)
      .lineSequence()
      .map(String::trim)
      .filter(String::isNotEmpty)
      .associate { line ->
        val row = json.decodeFromString<JsonObject>(line)
        row.getValue("kafka_offset").jsonPrimitive.long to row.getValue("rows").jsonPrimitive.long
      }
  }

  override fun close() {
    httpClient.close()
  }

  private fun execute(query: String): String {
    try {
      return runBlocking {
        withTimeout(config.requestTimeoutMs) {
          val response =
            httpClient.post(
              "${config.httpUrl.trimEnd('/')}?query=${URLEncoder.encode(query, Charsets.UTF_8)}",
            ) {
              if (config.password.isNotEmpty()) basicAuth(config.username, config.password)
            }
          val body = response.bodyAsText()
          check(response.status.isSuccess()) {
            "clickhouse_http_${response.status.value}:${body.take(256)}"
          }
          body
        }
      }
    } catch (error: Exception) {
      throw KafkaClickHouseStoreException("ClickHouse parity request failed", error)
    }
  }

  private fun identifier(value: String): String {
    require(value.matches(Regex("[A-Za-z_][A-Za-z0-9_]*"))) { "Invalid ClickHouse identifier: $value" }
    return value
  }

  private fun sqlString(value: String): String = "'${value.replace("\\", "\\\\").replace("'", "\\'")}'"

  private fun JsonObject.longOrNull(name: String): Long? {
    val value = getValue(name)
    return if (value is JsonNull) null else value.jsonPrimitive.long
  }
}
