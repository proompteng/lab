package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.config.TaServiceConfig
import ai.proompteng.dorvud.ta.engine.TaEngine
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TaEngineTest {
  @Test
  fun `computes indicators for rolling bars`() {
    val cfg =
      TaServiceConfig(
        bootstrapServers = "N/A",
        tradesTopic = "t",
        microBarsTopic = "out",
        signalsTopic = "sig",
      )
    val engine = TaEngine(cfg)

    var last: Envelope<TaSignalsPayload>? = null
    var ts = Instant.parse("2025-01-01T00:00:00Z")
    for (i in 0 until 40) {
      val price = 100.0 + i
      val barEnv =
        Envelope(
          ingestTs = ts,
          eventTs = ts,
          feed = "alpaca",
          channel = "trades",
          symbol = "TEST",
          seq = i.toLong(),
          payload =
            MicroBarPayload(
              o = price,
              h = price,
              l = price,
              c = price,
              v = 10.0,
              vwap = price,
              count = 1,
              t = ts,
            ),
          isFinal = true,
          source = "unit",
          window = Window(size = "PT1S", step = "PT1S", start = ts.toString(), end = ts.plus(1, ChronoUnit.SECONDS).toString()),
          version = 1,
        )
      last = engine.onMicroBar(barEnv)
      ts = ts.plusSeconds(1)
    }

    val payload = last?.payload
    assertNotNull(payload)
    assertNotNull(payload.macd)
    assertNotNull(payload.ema)
    assertNotNull(payload.boll)
    assertNotNull(payload.rsi14)
    val diff = kotlin.math.abs(payload.macd.hist - (payload.macd.macd - payload.macd.signal))
    assertTrue(diff < 1e-6)
    assertTrue { payload.ema.ema12 > 0 }
  }
}

private fun TaSignalsPayload.payloadPriceHint(): Double = ema?.ema12 ?: ema?.ema26 ?: macd?.macd ?: 0.0
