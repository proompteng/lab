package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import org.ta4j.core.BaseBar
import org.ta4j.core.BaseBarSeries
import org.ta4j.core.indicators.EMAIndicator
import org.ta4j.core.indicators.MACDIndicator
import org.ta4j.core.indicators.RSIIndicator
import org.ta4j.core.indicators.helpers.ClosePriceIndicator
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.ln
import kotlin.math.sqrt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TechnicalIndicatorsTest {
  private val interval = Duration.ofMinutes(1)
  private val start = Instant.parse("2026-09-11T13:30:00Z")

  private fun bar(
    index: Int,
    price: Double,
  ) = MicroBarPayload(
    price,
    price,
    price,
    price,
    2.0,
    price - 0.5,
    2,
    start.plusSeconds(index * 60L),
  )

  @Test fun `recursive values match pinned TA4J beyond the retained buffer`() {
    val series = BaseBarSeries("reference")
    val close = ClosePriceIndicator(series)
    val ema12 = EMAIndicator(close, 12)
    val ema26 = EMAIndicator(close, 26)
    val macd = MACDIndicator(close, 12, 26)
    val signal = EMAIndicator(macd, 9)
    val rsi = RSIIndicator(close, 14)
    var state = IndicatorAccumulator()
    for (index in 0..389) {
      val price = 100 + index * 0.05 + kotlin.math.sin(index.toDouble())
      val value = bar(index, price)
      series.addBar(BaseBar(interval, value.t.plus(interval).atZone(ZoneOffset.UTC), price, price, price, price, value.v))
      state = advanceIndicators(state, value, interval, 65)
      assertEquals(ema12.getValue(index).doubleValue(), state.ema12, 1e-8)
      assertEquals(ema26.getValue(index).doubleValue(), state.ema26, 1e-8)
      assertEquals(signal.getValue(index).doubleValue(), state.macdSignal, 1e-8)
      if (index >= 14) assertEquals(rsi.getValue(index).doubleValue(), indicatorRsi(state) ?: error("RSI unavailable"), 1e-8)
    }
    assertEquals(65, state.recent.size)
    assertEquals(390, state.count)
  }

  @Test fun `volatility uses all sixty returns and enforces its horizon`() {
    var state = IndicatorAccumulator()
    for (index in 0..60) {
      state = advanceIndicators(state, bar(index, if (index % 2 == 0) 100.0 else 110.0), interval, 65)
      if (index < 60) assertNull(indicatorVolatility(state, 60, interval))
    }
    assertEquals(ln(1.1), assertNotNull(indicatorVolatility(state, 60, interval)), 1e-12)
    assertNull(indicatorVolatility(state, 1, interval))
    val gap = advanceIndicators(state, bar(62, 105.0), interval, 65)
    assertNull(indicatorVolatility(gap, 60, interval))
    assertNull(indicatorRsi(gap))
  }

  @Test fun `warmup and population bands are explicit`() {
    var state = IndicatorAccumulator()
    for (index in 0..19) {
      state = advanceIndicators(state, bar(index, 100.0 + index), interval, 65)
      if (index < 14) assertNull(indicatorRsi(state))
      if (index < 19) assertNull(indicatorBollinger(state, interval))
    }
    val bands = assertNotNull(indicatorBollinger(state, interval))
    assertEquals(109.5, bands.mid)
    assertEquals(109.5 + 2 * sqrt(33.25), bands.upper, 1e-12)
  }

  @Test fun `weighted source VWAP is separate from weighted close and missing values stay missing`() {
    val bars = listOf(bar(0, 100.0), bar(1, 104.0).copy(v = 6.0))
    assertEquals(103.0, indicatorWeightedPrice(bars, false))
    assertEquals(102.5, indicatorWeightedPrice(bars, true))
    assertNull(indicatorWeightedPrice(bars.map { it.copy(vwap = null) }, true))
    assertNull(indicatorWeightedPrice(bars.map { it.copy(v = 0.0) }, false))
    val state = bars.fold(IndicatorAccumulator()) { previous, value -> advanceIndicators(previous, value, interval, 65) }
    assertTrue(state.sourceVwapComplete)
    assertEquals(102.5, state.vwapVolume / state.volume)
  }
}
