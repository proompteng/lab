package ai.proompteng.graf.config

import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KotlinSerializationConfigTest {
  private val config = KotlinSerializationConfig()

  @Test
  fun `json parser tolerates unknown keys and omits explicit nulls`() {
    val json = config.json()

    assertTrue(json.configuration.ignoreUnknownKeys)
    assertFalse(json.configuration.explicitNulls)

    val payload = """{"value":"ok","extra":"ignored"}"""
    val result = json.decodeFromString<Sample>(payload)

    assertEquals("ok", result.value)
  }

  @Serializable
  private data class Sample(
    val value: String,
  )
}
