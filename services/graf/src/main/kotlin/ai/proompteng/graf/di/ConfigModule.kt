package ai.proompteng.graf.di

import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.config.TemporalConfig
import kotlinx.serialization.json.Json
import org.koin.dsl.module

/**
 * Provides shared configuration objects and the JSON instance that backs the HTTP endpoints.
 */
val configModule =
  module {
    single { Neo4jConfig.fromEnvironment() }
    single { TemporalConfig.fromEnvironment() }
    single { ArgoConfig.fromEnvironment() }
    single { MinioConfig.fromEnvironment() }
    single {
      Json {
        encodeDefaults = true
        prettyPrint = false
        explicitNulls = false
        ignoreUnknownKeys = true
      }
    }
  }
