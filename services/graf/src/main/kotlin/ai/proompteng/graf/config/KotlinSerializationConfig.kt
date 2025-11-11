package ai.proompteng.graf.config

import jakarta.enterprise.inject.Produces
import jakarta.inject.Singleton
import kotlinx.serialization.json.Json

class KotlinSerializationConfig {
  @Produces
  @Singleton
  fun json(): Json =
    Json {
      ignoreUnknownKeys = true
      explicitNulls = false
      encodeDefaults = true
    }
}
