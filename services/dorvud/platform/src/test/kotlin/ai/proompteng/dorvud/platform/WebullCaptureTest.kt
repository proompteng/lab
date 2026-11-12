package ai.proompteng.dorvud.platform

import com.google.protobuf.CodedOutputStream
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class WebullCaptureTest {
  @Test
  fun `stock ticks index the full provider timestamp and retain the native clock value`() {
    fun message(write: CodedOutputStream.() -> Unit): ByteArray {
      val bytes = ByteArrayOutputStream()
      CodedOutputStream.newInstance(bytes).apply(write).flush()
      return bytes.toByteArray()
    }
    val basic =
      message {
        writeString(1, "TEST")
        writeString(2, "123")
        writeString(3, "1793610298520")
      }
    val bytes =
      message {
        writeByteArray(1, basic)
        writeString(2, "04:04:58")
        writeString(3, "1.123456789123456789")
        writeString(4, "12")
        writeString(5, "B")
      }
    val capture = webullCapture(WebullSource.Mqtt(UUID.randomUUID().toString(), "tick"), bytes)
    val restored = decodeWebullCapture(encodeWebullCapture(capture))
    assertEquals(bytes.toList(), restored.bytes().toList())
    val observation = inspectWebullCapture(restored).observations.single()
    assertEquals("1793610298520", observation.sourceTime)
    assertEquals(Instant.parse("2026-11-02T09:04:58.520Z"), webullProviderInstant(observation.sourceTime))
    assertEquals(null, webullProviderInstant("04:04:58"))
  }

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
