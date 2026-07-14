package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.buildAdmin
import ai.proompteng.dorvud.platform.buildConsumer
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import mu.KotlinLogging
import java.time.Instant
import kotlin.system.exitProcess

private val kafkaParityMainLogger = KotlinLogging.logger {}

internal fun runKafkaClickHouseParity() {
  val json =
    Json {
      encodeDefaults = true
      explicitNulls = false
    }
  val config =
    runCatching { KafkaClickHouseParityConfig.fromEnv() }
      .getOrElse { error ->
        kafkaParityMainLogger.error(error) { "invalid Kafka ClickHouse parity configuration" }
        exitProcess(2)
      }

  val manifest =
    runCatching {
      val consumer = buildConsumer(config.kafka)
      val admin =
        runCatching { buildAdmin(config.kafka) }
          .getOrElse { error ->
            consumer.close()
            throw error
          }
      LiveKafkaClickHouseParitySource(config, consumer, admin).use { source ->
        HttpKafkaClickHouseParityStore(config.clickHouse, HttpClient(CIO), json).use { store ->
          KafkaClickHouseParityVerifier(config, source, store).verify()
        }
      }
    }.getOrElse { error ->
      kafkaParityMainLogger.error(error) { "Kafka ClickHouse parity verification failed" }
      KafkaClickHouseParityManifest(
        ok = false,
        capturedAt = Instant.now().toString(),
        database = config.clickHouse.database,
        destinationSuffix = config.destinationSuffix,
        topicCount = config.topicTables.size,
        partitionCount = 0,
        blockerCount = 1,
        blockers = listOf("verification_failed:${error::class.simpleName ?: "unknown"}"),
        partitions = emptyList(),
      )
    }

  println(json.encodeToString(manifest))
  if (!manifest.ok) exitProcess(1)
}
