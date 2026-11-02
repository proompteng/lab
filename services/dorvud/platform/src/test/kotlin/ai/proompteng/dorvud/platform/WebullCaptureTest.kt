package ai.proompteng.dorvud.platform

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class WebullCaptureTest {
  @Test
  fun `provider share class symbols retain spaces while invalid UTF8 is rejected`() {
    val source = WebullSource.Http(WEBULL_QUOTES_PATH, listOf("CLASS B"))
    val capture = webullCapture(source, """{"symbol":"CLASS B","quote_time":1793404800161}""".toByteArray())
    assertEquals("CLASS B", inspectWebullCapture(capture).observations.single().symbol)
    assertFails { inspectWebullCapture(webullCapture(source, byteArrayOf(0xc3.toByte(), 0x28))) }
  }

  @Test
  fun `raw bytes and decimal text survive Kafka serialization and independent archive validation`() {
    val bytes = "{\"symbol\":\"AAPL\",\"quote_time\":1793404800161,\"price\":\"1.123456789123456789\"}".toByteArray()
    val capture =
      webullCapture(WebullSource.Http(WEBULL_QUOTES_PATH, listOf("AAPL")), bytes, Instant.parse("2026-11-01T01:02:03.123456789Z"))
    val restored = decodeWebullCapture(encodeWebullCapture(capture))
    assertEquals(bytes.toList(), restored.bytes().toList())
    assertEquals("2026-11-01T01:02:03.123456789Z", restored.receivedAt)
    assertEquals(listOf(WebullObservation("AAPL", "1793404800161")), inspectWebullCapture(restored).observations)
    assertFails { decodeWebullCapture(encodeWebullCapture(capture.copy(payloadSha256 = "0".repeat(64)))) }
    assertFails { capture.copy(provider = "alpaca").validate() }
    assertFails { capture.copy(source = WebullSource.Http("/trading/orders/place", emptyList())).validate() }
  }
}
