package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertNotNull

class LoggingConfigTest {
  @Test
  fun `keeps kafka client internals out of default debug logs`() {
    val resource = Thread.currentThread().contextClassLoader.getResource("logback.xml")
    assertNotNull(resource)

    val config = resource.readText()
    assertContains(config, """<root level="${'$'}{LOG_LEVEL:-INFO}">""")
    assertContains(config, """<logger name="org.apache.kafka" level="${'$'}{KAFKA_CLIENT_LOG_LEVEL:-WARN}" />""")
    assertContains(config, """<logger name="org.apache.kafka.clients.NetworkClient" level="WARN" />""")
  }
}
