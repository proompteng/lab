package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.ta.stream.OptionsContractFeaturePayload
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class OptionsTechnicalAnalysisJobTest {
  @Test
  fun `surface payload is suppressed until coverage is meaningful`() {
    val payload =
      buildOptionsSurfaceFeaturePayload(
        underlyingSymbol = "AAPL",
        payloads =
          listOf(
            feature(optionType = "call", dte = 10, delta = 0.5, impliedVolatility = 0.30),
            feature(optionType = "put", dte = 12, delta = -0.5, impliedVolatility = 0.32),
            feature(optionType = "call", dte = 30, delta = 0.25, impliedVolatility = 0.28),
          ),
      )

    assertNull(payload)
  }

  @Test
  fun `surface payload ignores stale snapshot contracts for skew and term structure`() {
    val payload =
      buildOptionsSurfaceFeaturePayload(
        underlyingSymbol = "AAPL",
        payloads =
          listOf(
            feature(optionType = "call", dte = 10, delta = 0.5, impliedVolatility = 0.30),
            feature(optionType = "put", dte = 12, delta = -0.5, impliedVolatility = 0.32),
            feature(optionType = "call", dte = 30, delta = 0.25, impliedVolatility = 0.28),
            feature(optionType = "put", dte = 40, delta = -0.25, impliedVolatility = 0.35),
            feature(optionType = "call", dte = 50, delta = 0.10, impliedVolatility = 0.27),
            feature(optionType = "put", dte = 60, delta = -0.10, impliedVolatility = 0.36),
            feature(optionType = "call", dte = 5, delta = 0.5, impliedVolatility = 0.99, staleSnapshot = true),
            feature(optionType = "put", dte = 90, delta = -0.25, impliedVolatility = 0.01, staleSnapshot = true),
          ),
      )

    requireNotNull(payload)
    assertEquals(0.31, requireNotNull(payload.atmIv), 1e-9)
    assertEquals(0.07, requireNotNull(payload.callPutSkew25d), 1e-9)
    assertEquals(0.09, requireNotNull(payload.callPutSkew10d), 1e-9)
    assertEquals(0.06, requireNotNull(payload.termSlopeFrontBack), 1e-9)
    assertEquals(-0.02, requireNotNull(payload.termSlopeFrontMid), 1e-9)
    assertEquals(0.75, requireNotNull(payload.surfaceBreadth), 1e-9)
    assertEquals(0.75, requireNotNull(payload.hotContractCoverageRatio), 1e-9)
    assertEquals(1.0, requireNotNull(payload.snapshotCoverageRatio), 1e-9)
    assertEquals("ok", payload.featureQualityStatus)
  }

  private fun feature(
    optionType: String,
    dte: Int,
    delta: Double,
    impliedVolatility: Double,
    staleSnapshot: Boolean = false,
  ): OptionsContractFeaturePayload =
    OptionsContractFeaturePayload(
      underlyingSymbol = "AAPL",
      expirationDate = "2026-03-20",
      strikePrice = 100.0 + dte,
      optionType = optionType,
      dte = dte,
      moneyness = null,
      spreadAbs = 0.05,
      spreadBps = 25.0,
      bidSize = 10.0,
      askSize = 12.0,
      quoteImbalance = -0.0909090909,
      tradeCountW60s = 5,
      notionalW60s = 250.0,
      quoteUpdatesW60s = 8,
      realizedVolW60s = 0.2,
      impliedVolatility = impliedVolatility,
      ivChangeW60s = 0.01,
      delta = delta,
      deltaChangeW60s = 0.01,
      gamma = 0.02,
      theta = -0.01,
      vega = 0.15,
      rho = 0.01,
      midPrice = 2.0,
      markPrice = 2.0,
      midChangeW60s = 0.05,
      markChangeW60s = 0.05,
      staleQuote = false,
      staleSnapshot = staleSnapshot,
      featureQualityStatus = if (staleSnapshot) "stale_snapshot" else "ok",
    )
}
