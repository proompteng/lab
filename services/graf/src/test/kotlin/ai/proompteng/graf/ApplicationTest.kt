package ai.proompteng.graf

import kotlin.test.Test
import kotlin.test.assertEquals

class ApplicationTest {
  @Test
  fun `formatAccessLog strips ansi codes`() {
    val raw = "\u001B[32m200 OK\u001B[m"
    val stripped = raw.stripAnsi()
    assertEquals("200 OK", stripped)
  }

  @Test
  fun `formatAccessLog builds readable string`() {
    val formatted = formatAccessLog("GET", "/healthz", 200, 12)
    assertEquals("200 GET - /healthz in 12ms", formatted)
  }
}
