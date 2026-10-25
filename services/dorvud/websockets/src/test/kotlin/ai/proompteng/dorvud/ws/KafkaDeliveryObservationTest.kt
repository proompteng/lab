package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class KafkaDeliveryObservationTest {
  private val envelope =
    Envelope(
      ingestTs = Instant.parse("2026-09-03T15:00:00Z"),
      eventTs = Instant.parse("2026-09-03T15:00:00Z"),
      feed = "iex",
      channel = "quotes",
      symbol = "NVDA",
      seq = 1,
      payload = JsonPrimitive("large-payload-is-not-retained"),
    )

  @Test
  fun `retains only delivery metadata for websocket records`() {
    assertEquals(
      KafkaDeliveryObservation(channel = "quotes", symbol = "NVDA"),
      kafkaDeliveryObservation(envelope, "quotes"),
    )
  }

  @Test
  fun `does not track archive freshness for non websocket records`() {
    assertNull(kafkaDeliveryObservation(envelope.copy(source = "backfill"), "quotes").channel)
  }
}
