package ai.proompteng.graf.runtime

import kotlinx.serialization.json.Json

fun grafJson(): Json =
  Json {
    encodeDefaults = true
    explicitNulls = false
    ignoreUnknownKeys = true
    prettyPrint = false
  }
