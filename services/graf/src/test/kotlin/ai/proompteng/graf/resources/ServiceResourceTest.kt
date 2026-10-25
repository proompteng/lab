package ai.proompteng.graf.resources

import io.mockk.every
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkObject
import kotlin.test.Test
import kotlin.test.assertEquals

class ServiceResourceTest {
  @Test
  fun `root responds with Graf metadata from env`() =
    withEnv(
      mapOf(
        "GRAF_VERSION" to "2025.11.11",
        "GRAF_COMMIT" to "abc123",
      ),
    ) {
      val resource = ServiceResource()

      val response = resource.root()

      assertEquals("graf", response.service)
      assertEquals("ok", response.status)
      assertEquals("2025.11.11", response.version)
      assertEquals("abc123", response.commit)
    }

  @Test
  fun `healthz returns ok status and port`() =
    withEnv(
      mapOf(
        "PORT" to "8080",
      ),
    ) {
      val resource = ServiceResource()

      val response = resource.healthz()

      assertEquals("ok", response.status)
      assertEquals("8080", response.port)
    }

  private fun withEnv(
    env: Map<String, String?>,
    block: () -> Unit,
  ) {
    mockkObject(ServiceEnvironment)
    val keySlot = slot<String>()
    every { ServiceEnvironment.get(capture(keySlot)) } answers { env[keySlot.captured] }
    try {
      block()
    } finally {
      unmockkObject(ServiceEnvironment)
    }
  }
}
