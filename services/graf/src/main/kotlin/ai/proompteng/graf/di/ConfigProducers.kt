package ai.proompteng.graf.di

import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.config.TemporalConfig
import jakarta.enterprise.inject.Produces
import jakarta.inject.Singleton
import kotlinx.serialization.json.Json

@Suppress("ktlint:standard:function-expression-body", "ktlint:standard:function-signature")
@Singleton
class ConfigProducers {
  private val neo4jConfig = Neo4jConfig.fromEnvironment()
  private val temporalConfig = TemporalConfig.fromEnvironment()
  private val argoConfig = ArgoConfig.fromEnvironment()
  private val minioConfig = MinioConfig.fromEnvironment()
  private val sharedJson =
    Json {
      encodeDefaults = true
      prettyPrint = false
      explicitNulls = false
      ignoreUnknownKeys = true
    }

  @Singleton
  @Produces
  fun neo4jConfig(): Neo4jConfig = neo4jConfig

  @Singleton
  @Produces
  fun temporalConfig(): TemporalConfig = temporalConfig

  @Singleton
  @Produces
  fun argoConfig(): ArgoConfig = argoConfig

  @Singleton
  @Produces
  fun minioConfig(): MinioConfig = minioConfig

  @GrafJson
  @Singleton
  @Produces
  fun sharedJson(): Json = sharedJson
}
