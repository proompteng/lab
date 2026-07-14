package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.request.basicAuth
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.security.MessageDigest

data class KafkaClickHouseRecord(
  val topic: String,
  val partition: Int,
  val offset: Long,
  val key: String,
  val envelope: HyperliquidEnvelope,
)

data class KafkaClickHouseInsertResult(
  val rows: Int,
  val bytes: Int,
)

interface KafkaClickHouseStore : AutoCloseable {
  fun persistedOffsets(
    table: String,
    topic: String,
    partition: Int,
    firstOffset: Long,
    lastOffset: Long,
  ): Set<Long>

  fun insert(
    table: String,
    records: List<KafkaClickHouseRecord>,
    deduplicationToken: String,
  ): KafkaClickHouseInsertResult

  override fun close()
}

class KafkaClickHouseStoreException(
  message: String,
  cause: Throwable,
) : RuntimeException(message, cause)

class HttpKafkaClickHouseStore(
  private val config: ClickHouseConfig,
  private val httpClient: HttpClient,
  private val json: Json,
) : KafkaClickHouseStore {
  override fun persistedOffsets(
    table: String,
    topic: String,
    partition: Int,
    firstOffset: Long,
    lastOffset: Long,
  ): Set<Long> {
    require(firstOffset <= lastOffset) { "Kafka offset range is reversed" }
    val query =
      """
      SELECT kafka_offset
      FROM ${identifier(config.database)}.${identifier(table)}
      WHERE kafka_topic = ${sqlString(topic)}
        AND kafka_partition = $partition
        AND kafka_offset BETWEEN $firstOffset AND $lastOffset
      GROUP BY kafka_offset
      FORMAT JSONEachRow
      """.trimIndent()
    return execute(query)
      .lineSequence()
      .map(String::trim)
      .filter(String::isNotEmpty)
      .map { line ->
        json
          .decodeFromString<JsonObject>(line)
          .getValue("kafka_offset")
          .jsonPrimitive.long
      }.toSet()
  }

  override fun insert(
    table: String,
    records: List<KafkaClickHouseRecord>,
    deduplicationToken: String,
  ): KafkaClickHouseInsertResult {
    require(records.isNotEmpty()) { "Cannot insert an empty Kafka batch" }
    require(deduplicationToken.matches(Regex("[a-f0-9]{64}"))) { "Invalid ClickHouse deduplication token" }
    val body =
      records.joinToString("\n") { record ->
        json.encodeToString(
          clickHouseRowFor(
            json,
            RoutedEnvelope(topic = record.topic, key = record.key, envelope = record.envelope),
            KafkaLineage(topic = record.topic, partition = record.partition, offset = record.offset),
          ),
        )
      }
    val query =
      "INSERT INTO ${identifier(config.database)}.${identifier(table)} " +
        "SETTINGS insert_deduplication_token = '$deduplicationToken' FORMAT JSONEachRow"
    execute(query, body)
    return KafkaClickHouseInsertResult(rows = records.size, bytes = body.toByteArray(Charsets.UTF_8).size)
  }

  override fun close() {
    httpClient.close()
  }

  private fun execute(
    query: String,
    body: String? = null,
  ): String {
    try {
      return runBlocking {
        withTimeout(config.requestTimeoutMs) {
          val response =
            httpClient.post(
              "${config.httpUrl.trimEnd('/')}?query=${java.net.URLEncoder.encode(query, Charsets.UTF_8)}",
            ) {
              if (config.password.isNotEmpty()) basicAuth(config.username, config.password)
              if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
              }
            }
          val responseBody = response.bodyAsText()
          check(response.status.isSuccess()) {
            "clickhouse_http_${response.status.value}:${responseBody.take(256)}"
          }
          responseBody
        }
      }
    } catch (error: Exception) {
      throw KafkaClickHouseStoreException("ClickHouse Kafka writer request failed", error)
    }
  }

  private fun identifier(value: String): String {
    require(value.matches(Regex("[A-Za-z_][A-Za-z0-9_]*"))) { "Invalid ClickHouse identifier: $value" }
    return value
  }

  private fun sqlString(value: String): String = "'${value.replace("\\", "\\\\").replace("'", "\\'")}'"
}

internal fun kafkaBatchDeduplicationToken(records: List<KafkaClickHouseRecord>): String {
  require(records.isNotEmpty()) { "Cannot create a token for an empty Kafka batch" }
  val first = records.first()
  require(records.all { it.topic == first.topic && it.partition == first.partition }) {
    "Kafka ClickHouse batch must contain exactly one topic partition"
  }
  val material =
    buildString {
      append(first.topic)
      append(':')
      append(first.partition)
      records.forEach { record ->
        append(':')
        append(record.offset)
      }
    }
  return MessageDigest
    .getInstance("SHA-256")
    .digest(material.toByteArray(Charsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte) }
}
