package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WEBULL_BARS_PATH
import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.inspectWebullCapture
import ai.proompteng.dorvud.platform.webullCapture
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class WebullProgressTest {
  private val request = """{"timespan":"M1","real_time_required":true,"start_time":1793386800000,"end_time":1793386919999}"""

  private fun capture(times: List<String>) =
    webullCapture(
      WebullSource.Http(WEBULL_BARS_PATH, listOf("AAPL"), requestBody = request),
      (
        """{"result":[{"symbol":"AAPL","delay_minutes":0,"result":[""" +
          times.joinToString(",") { """{"time":"$it","open":"1.000000001","high":"1.1","low":"1","close":"1.01","volume":"10"}""" } +
          "]}]}"
      ).toByteArray(),
      Instant.parse("2026-10-30T19:02:01.000000001Z"),
    )

  @Test
  fun `an out of window cached bar does not discard completed peers`() {
    val capture =
      capture(
        listOf(
          "2026-10-30T19:02:00.000+0000",
          "2026-10-30T19:01:00.000+0000",
          "2026-10-30T19:00:00.000+0000",
          "2026-10-30T18:59:00.000+0000",
        ),
      )
    val payload = inspectWebullCapture(capture)
    assertEquals(listOf("2026-10-30T19:01:00.000+0000", "2026-10-30T19:00:00.000+0000"), payload.observations.map { it.sourceTime })
    assertEquals(2, payload.outOfWindowBars)
    val progress = WebullProgress()
    progress.record(capture, payload)
    assertEquals(
      "2",
      progress
        .report()
        .getValue("excludedOutOfWindowBars")
        .jsonPrimitive.content,
    )
  }

  @Test
  fun `descending provider bars retain newest coverage while unfinished bars remain unobserved`() {
    val capture = capture(listOf("2026-10-30T19:01:00.000+0000", "2026-10-30T19:00:00.000+0000"))
    val progress = WebullProgress()
    progress.record(capture, inspectWebullCapture(capture))
    assertEquals(
      "2026-10-30T19:01:00.000+0000",
      progress
        .report()["observedSymbolsByChannel"]!!
        .jsonObject["bars"]!!
        .jsonObject["lastProviderTimes"]!!
        .jsonObject["AAPL"]!!
        .jsonPrimitive.content,
    )
    val unfinished = inspectWebullCapture(capture(listOf("2026-10-30T19:02:00.000+0000")))
    assertEquals(emptyList(), unfinished.observations)
    assertEquals(1, unfinished.outOfWindowBars)
    assertFails { inspectWebullCapture(capture(listOf("2026-10-30T19:00:30.000+0000"))) }
  }
}
