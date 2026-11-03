package ai.proompteng.dorvud.platform

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class WebullBarsTest {
  private val request =
    """{"timespan":"M1","real_time_required":true,"trading_sessions":"PRE,RTH,ATH",
      "start_time":1793610000000,"end_time":1793610119999}"""

  private fun bar(
    time: String,
    session: String = "PRE",
  ): String =
    """{"time":"$time","trading_session":"$session","open":"1.123456789123456789",
      "high":"2.0","low":"1.0","close":"1.500000000000000001","volume":"10.000000001"}"""

  private fun group(
    symbol: String,
    vararg bars: String,
  ): String = """{"symbol":"$symbol","delay_minutes":"0","result":[${bars.joinToString(",")}]}"""

  private fun inspect(
    body: String,
    symbols: List<String> = listOf("TEST"),
  ): WebullPayload =
    inspectWebullCapture(
      webullCapture(
        WebullSource.Http(WEBULL_BARS_PATH, symbols, requestBody = request),
        body.toByteArray(),
        Instant.parse("2026-11-02T09:02:01.123456789Z"),
      ),
    )

  @Test
  fun `completed minute bars preserve native decimal strings and provider session`() {
    val group = group("TEST", bar("2026-11-02T09:00:00Z"))
    val payload = inspect("""{"result":[$group]}""")
    assertEquals(
      WebullMinuteBar(
        "TEST",
        1793610000000,
        WebullTradingSession.PRE,
        "1.123456789123456789",
        "2.0",
        "1.0",
        "1.500000000000000001",
        "10.000000001",
      ),
      payload.minuteBars.single(),
    )
    assertEquals(WebullBarRequest("TEST", WebullBarRequestState.OBSERVED, 1, 0), payload.barRequests.single())
    assertEquals("2026-11-02T09:00:00Z", payload.observations.single().sourceTime)
  }

  @Test
  fun `empty excluded omitted and observed responses remain distinct without invented bars`() {
    val groups =
      listOf(
        group("TEST", bar("2026-11-02T09:00:00Z")),
        group("EMPTY"),
        group("OLD", bar("2026-11-02T08:59:00Z")),
      )
    val payload = inspect("""{"result":[${groups.joinToString(",")}]}""", listOf("TEST", "EMPTY", "OLD", "OMITTED"))
    assertEquals(1, payload.minuteBars.size)
    assertEquals(1, payload.outOfWindowBars)
    assertEquals(
      listOf(WebullBarRequestState.OBSERVED, WebullBarRequestState.EMPTY, WebullBarRequestState.EXCLUDED, WebullBarRequestState.OMITTED),
      payload.barRequests.map { it.state },
    )
  }

  @Test
  fun `unknown sessions duplicate minutes and duplicate groups fail native validation`() {
    val unknown = group("TEST", bar("2026-11-02T09:00:00Z", "OVN"))
    assertFails { inspect("""{"result":[$unknown]}""") }
    val repeated = group("TEST", bar("2026-11-02T09:00:00Z"), bar("2026-11-02T09:00:00Z"))
    assertFails { inspect("""{"result":[$repeated]}""") }
    val group = group("TEST")
    assertFails { inspect("""{"result":[$group,$group]}""") }
  }
}
