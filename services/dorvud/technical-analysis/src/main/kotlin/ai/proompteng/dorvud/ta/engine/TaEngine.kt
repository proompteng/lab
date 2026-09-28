package ai.proompteng.dorvud.ta.engine

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.config.TaServiceConfig
import ai.proompteng.dorvud.ta.stream.Bollinger
import ai.proompteng.dorvud.ta.stream.Ema
import ai.proompteng.dorvud.ta.stream.Imbalance
import ai.proompteng.dorvud.ta.stream.Macd
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.QuotePayload
import ai.proompteng.dorvud.ta.stream.RealizedVol
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import ai.proompteng.dorvud.ta.stream.Vwap
import ai.proompteng.dorvud.ta.stream.withPayload
import org.ta4j.core.BarSeries
import org.ta4j.core.BaseBar
import org.ta4j.core.BaseBarSeries
import org.ta4j.core.indicators.EMAIndicator
import org.ta4j.core.indicators.MACDIndicator
import org.ta4j.core.indicators.RSIIndicator
import org.ta4j.core.indicators.SMAIndicator
import org.ta4j.core.indicators.bollinger.BollingerBandsLowerIndicator
import org.ta4j.core.indicators.bollinger.BollingerBandsMiddleIndicator
import org.ta4j.core.indicators.bollinger.BollingerBandsUpperIndicator
import org.ta4j.core.indicators.helpers.ClosePriceIndicator
import org.ta4j.core.indicators.statistics.StandardDeviationIndicator
import java.time.Duration
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.ln

/**
 * Wraps TA4J indicators. One BarSeries per symbol; computes indicators when a new micro-bar arrives.
 */
class TaEngine(
  private val config: TaServiceConfig,
) {
  private val seriesBySymbol = ConcurrentHashMap<String, BarSeries>()
  private val lastQuoteBySymbol = ConcurrentHashMap<String, QuotePayload>()
  private val sessionVwap = ConcurrentHashMap<String, SessionAccumulator>()

  fun onQuote(envelope: Envelope<QuotePayload>) {
    lastQuoteBySymbol[envelope.symbol] = envelope.payload
  }

  fun onMicroBar(envelope: Envelope<MicroBarPayload>): Envelope<TaSignalsPayload>? {
    val symbol = envelope.symbol
    val series = seriesBySymbol.computeIfAbsent(symbol) { BaseBarSeries(symbol) }
    val barTime = ZonedDateTime.ofInstant(envelope.payload.t, ZoneOffset.UTC)
    val bar =
      BaseBar(
        Duration.ofSeconds(1),
        barTime,
        envelope.payload.o,
        envelope.payload.h,
        envelope.payload.l,
        envelope.payload.c,
        envelope.payload.v,
      )
    series.addBar(bar)

    val close = ClosePriceIndicator(series)
    val ema12 = EMAIndicator(close, 12)
    val ema26 = EMAIndicator(close, 26)
    val ema12Val = ema12.getValue(series.endIndex).doubleValue()
    val ema26Val = ema26.getValue(series.endIndex).doubleValue()

    val macdIndicator = MACDIndicator(close, 12, 26)
    val macdVal = macdIndicator.getValue(series.endIndex).doubleValue()
    val signalVal = EMAIndicator(macdIndicator, 9).getValue(series.endIndex).doubleValue()
    val histVal = macdVal - signalVal

    val rsiVal = if (series.endIndex + 1 >= 2) RSIIndicator(close, 14).getValue(series.endIndex).doubleValue() else null

    val sma20 = SMAIndicator(close, 20)
    val middle = BollingerBandsMiddleIndicator(sma20)
    val stdDev = StandardDeviationIndicator(close, 20)
    val upperIndicator = BollingerBandsUpperIndicator(middle, stdDev)
    val lowerIndicator = BollingerBandsLowerIndicator(middle, stdDev)
    val boll =
      if (series.endIndex + 1 >= 20) {
        Bollinger(
          mid = middle.getValue(series.endIndex).doubleValue(),
          upper = upperIndicator.getValue(series.endIndex).doubleValue(),
          lower = lowerIndicator.getValue(series.endIndex).doubleValue(),
        )
      } else {
        null
      }

    val vwapSession =
      sessionVwap
        .compute(symbol) { _, acc ->
          val existing = acc ?: SessionAccumulator()
          existing.add(envelope.payload.c, envelope.payload.v)
          existing
        }!!
        .value()

    val vwap5m = rollingVwap(series, config.vwapWindow)
    val realizedVol = realizedVol(series, config.realizedVolWindow)

    val quote = lastQuoteBySymbol[symbol]
    val imbalance =
      quote?.let {
        val spread = it.ap - it.bp
        Imbalance(spread = spread, bid_px = it.bp, ask_px = it.ap, bid_sz = it.bs, ask_sz = it.`as`)
      }

    val payload =
      TaSignalsPayload(
        macd = Macd(macd = macdVal, signal = signalVal, hist = histVal),
        ema = Ema(ema12 = ema12Val, ema26 = ema26Val),
        rsi14 = rsiVal,
        boll = boll,
        vwap = Vwap(session = vwapSession, w5m = vwap5m),
        imbalance = imbalance,
        vol_realized = realizedVol?.let { RealizedVol(it) },
      )

    val windowStart =
      envelope.payload.t
        .minusSeconds(1)
        .toString()
    val window = envelope.window ?: Window(size = "PT1S", step = "PT1S", start = windowStart, end = envelope.payload.t.toString())
    return envelope.withPayload(payload, window = window)
  }

  private fun rollingVwap(
    series: BarSeries,
    window: Duration,
  ): Double? {
    val bars = series.barCount
    if (bars == 0) return null
    val windowBars = (window.seconds).toInt()
    var sumPv = 0.0
    var sumVol = 0.0
    for (i in (bars - windowBars).coerceAtLeast(0) until bars) {
      val bar = series.getBar(i)
      sumPv += bar.closePrice.doubleValue() * bar.volume.doubleValue()
      sumVol += bar.volume.doubleValue()
    }
    if (sumVol == 0.0) return null
    return sumPv / sumVol
  }

  private fun realizedVol(
    series: BarSeries,
    window: Int,
  ): Double? {
    if (series.barCount < 2) return null
    val end = series.endIndex
    val start = (series.barCount - window).coerceAtLeast(1)
    val returns = mutableListOf<Double>()
    var prevClose = series.getBar(start - 1).closePrice.doubleValue()
    for (i in start..end) {
      val close = series.getBar(i).closePrice.doubleValue()
      returns += ln(close / prevClose)
      prevClose = close
    }
    if (returns.isEmpty()) return null
    val mean = returns.average()
    val variance = returns.map { (it - mean) * (it - mean) }.average()
    return kotlin.math.sqrt(variance)
  }

  private class SessionAccumulator {
    private var pv = 0.0
    private var vol = 0.0

    fun add(
      price: Double,
      volume: Double,
    ) {
      pv += price * volume
      vol += volume
    }

    fun value(): Double = if (vol == 0.0) 0.0 else pv / vol
  }
}
