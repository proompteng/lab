package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.ta.stream.OptionsContractFeaturePayload
import ai.proompteng.dorvud.ta.stream.OptionsSnapshotPayload
import org.apache.flink.connector.base.DeliveryGuarantee
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OptionsTechnicalAnalysisJobTest {
  @Test
  fun `status sink delivery guarantee defaults to non transactional status output`() {
    assertEquals(DeliveryGuarantee.AT_LEAST_ONCE, parseOptionsDeliveryGuarantee(null, DeliveryGuarantee.AT_LEAST_ONCE))
    assertEquals(
      DeliveryGuarantee.AT_LEAST_ONCE,
      parseOptionsDeliveryGuarantee("AT_LEAST_ONCE", DeliveryGuarantee.EXACTLY_ONCE),
    )
    assertEquals(
      DeliveryGuarantee.EXACTLY_ONCE,
      parseOptionsDeliveryGuarantee("exactly_once", DeliveryGuarantee.AT_LEAST_ONCE),
    )
    assertEquals(DeliveryGuarantee.NONE, parseOptionsDeliveryGuarantee("none", DeliveryGuarantee.AT_LEAST_ONCE))
    assertEquals(
      DeliveryGuarantee.AT_LEAST_ONCE,
      parseOptionsDeliveryGuarantee("bad-value", DeliveryGuarantee.AT_LEAST_ONCE),
    )
  }

  @Test
  fun `snapshot quote state uses provider latest quote timestamp and quote prices`() {
    val quoteTs = Instant.parse("2026-06-18T20:03:44Z")
    val fallbackTs = Instant.parse("2026-06-18T20:03:45Z")
    val quote =
      snapshotQuoteState(
        snapshot(
          latestBidPrice = 1.25,
          latestBidSize = 10.0,
          latestAskPrice = 1.35,
          latestAskSize = 12.0,
          latestQuoteTs = quoteTs.toString(),
        ),
        fallbackTs.toEpochMilli(),
      )

    assertNotNull(quote)
    assertEquals(quoteTs.toEpochMilli(), quote.eventMs)
    assertEquals(1.25, quote.bidPrice)
    assertEquals(10.0, quote.bidSize)
    assertEquals(1.35, quote.askPrice)
    assertEquals(12.0, quote.askSize)
    assertEquals("AAPL", quote.underlyingSymbol)
  }

  @Test
  fun `snapshot reference price ignores latest trade price without mark mid or quote`() {
    val snapshot = snapshot(latestTradePrice = 99.0)

    assertNull(snapshotReferencePrice(snapshot, null))
  }

  @Test
  fun `snapshot reference price uses mark then mid then quote mid`() {
    val quote =
      snapshotQuoteState(
        snapshot(
          latestBidPrice = 1.20,
          latestBidSize = 10.0,
          latestAskPrice = 1.40,
          latestAskSize = 12.0,
        ),
        Instant.parse("2026-06-18T20:03:45Z").toEpochMilli(),
      )

    assertEquals(2.50, snapshotReferencePrice(snapshot(markPrice = 2.50, midPrice = 2.40), quote))
    assertEquals(2.40, snapshotReferencePrice(snapshot(midPrice = 2.40), quote))
    assertEquals(1.30, requireNotNull(snapshotReferencePrice(snapshot(), quote)), 1e-9)
  }

  @Test
  fun `snapshot only quote or mark data opens analytics bucket without synthetic trades`() {
    val bucket =
      snapshotAnalyticsBucket(
        existing = null,
        snapshot = snapshot(markPrice = 2.50),
        quote = null,
        windowStartMs = 1_000L,
        windowEndMs = 2_000L,
      )

    assertNotNull(bucket)
    assertEquals("AAPL", bucket.underlyingSymbol)
    assertEquals(0L, bucket.count)
    assertEquals(0.0, bucket.volume)
    assertTrue(bucket.sawSnapshot)
    assertFalse(bucket.sawQuote)
    assertEquals("flink-snapshot", optionsOutputSource(bucket))
  }

  @Test
  fun `snapshot without quote mark or mid does not open analytics bucket`() {
    assertNull(
      snapshotAnalyticsBucket(
        existing = null,
        snapshot = snapshot(latestTradePrice = 99.0),
        quote = null,
        windowStartMs = 1_000L,
        windowEndMs = 2_000L,
      ),
    )
  }

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

  private fun snapshot(
    latestTradePrice: Double? = null,
    latestBidPrice: Double? = null,
    latestBidSize: Double? = null,
    latestAskPrice: Double? = null,
    latestAskSize: Double? = null,
    latestQuoteTs: String? = null,
    markPrice: Double? = null,
    midPrice: Double? = null,
  ): OptionsSnapshotPayload =
    OptionsSnapshotPayload(
      contractSymbol = "AAPL260320C00100000",
      underlyingSymbol = "AAPL",
      latestTradePrice = latestTradePrice,
      latestBidPrice = latestBidPrice,
      latestBidSize = latestBidSize,
      latestAskPrice = latestAskPrice,
      latestAskSize = latestAskSize,
      latestQuoteTs = latestQuoteTs,
      markPrice = markPrice,
      midPrice = midPrice,
      snapshotClass = "snapshot",
    )
}
