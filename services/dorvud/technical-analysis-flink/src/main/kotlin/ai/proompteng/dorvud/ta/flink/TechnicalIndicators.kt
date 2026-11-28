package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.ta.stream.Bollinger
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import java.io.Serializable
import java.time.Duration
import kotlin.math.ln
import kotlin.math.sqrt

/** Checkpointed recursive values retain their original seed when the rolling buffer advances. */
internal data class IndicatorAccumulator(
  val count: Int = 0,
  val recent: List<MicroBarPayload> = emptyList(),
  val ema12: Double = 0.0,
  val ema26: Double = 0.0,
  val macdSignal: Double = 0.0,
  val gain14: Double = 0.0,
  val loss14: Double = 0.0,
  val volume: Double = 0.0,
  val closeVolume: Double = 0.0,
  val vwapVolume: Double = 0.0,
  val sourceVwapComplete: Boolean = true,
  val contiguous: Boolean = true,
) : Serializable

internal fun advanceIndicators(
  previous: IndicatorAccumulator,
  bar: MicroBarPayload,
  interval: Duration,
  retainedBars: Int,
): IndicatorAccumulator {
  require(!interval.isNegative && !interval.isZero && retainedBars >= 61) { "invalid indicator window" }
  require(listOf(bar.o, bar.h, bar.l, bar.c).all { it.isFinite() && it > 0 } && bar.v.isFinite() && bar.v >= 0) {
    "invalid indicator bar"
  }
  require(bar.l <= minOf(bar.o, bar.c) && bar.h >= maxOf(bar.o, bar.c) && bar.h >= bar.l) { "inconsistent indicator range" }
  require(bar.vwap?.let { it.isFinite() && it > 0 } != false) { "invalid source VWAP" }
  val last = previous.recent.lastOrNull()
  require(last == null || bar.t.isAfter(last.t)) { "indicator inputs must be canonical and ordered" }
  val ema12 = if (last == null) bar.c else previous.ema12 + (bar.c - previous.ema12) * (2.0 / 13)
  val ema26 = if (last == null) bar.c else previous.ema26 + (bar.c - previous.ema26) * (2.0 / 27)
  val macd = ema12 - ema26
  val change = if (last == null) 0.0 else bar.c - last.c
  return IndicatorAccumulator(
    count = previous.count + 1,
    recent = (previous.recent + bar).takeLast(retainedBars),
    ema12 = ema12,
    ema26 = ema26,
    macdSignal = previous.macdSignal + (macd - previous.macdSignal) * (2.0 / 10),
    gain14 = previous.gain14 + (maxOf(change, 0.0) - previous.gain14) / 14,
    loss14 = previous.loss14 + (maxOf(-change, 0.0) - previous.loss14) / 14,
    volume = previous.volume + bar.v,
    closeVolume = previous.closeVolume + bar.c * bar.v,
    vwapVolume = previous.vwapVolume + (bar.vwap ?: 0.0) * bar.v,
    sourceVwapComplete = previous.sourceVwapComplete && (bar.v == 0.0 || bar.vwap != null),
    contiguous = previous.contiguous && (last == null || last.t.plus(interval) == bar.t),
  )
}

internal fun indicatorRsi(state: IndicatorAccumulator): Double? =
  when {
    state.count < 15 || !state.contiguous -> null
    state.loss14 == 0.0 -> if (state.gain14 == 0.0) 0.0 else 100.0
    else -> 100 - 100 / (1 + state.gain14 / state.loss14)
  }

internal fun contiguousIndicatorTail(
  bars: List<MicroBarPayload>,
  count: Int,
  interval: Duration,
): List<MicroBarPayload>? {
  if (bars.size < count) return null
  val selected = bars.takeLast(count)
  return selected.takeIf { it.zipWithNext().all { (left, right) -> left.t.plus(interval) == right.t } }
}

internal fun indicatorBollinger(
  state: IndicatorAccumulator,
  interval: Duration,
): Bollinger? {
  val closes = contiguousIndicatorTail(state.recent, 20, interval)?.map { it.c } ?: return null
  val mean = closes.average()
  val deviation = sqrt(closes.sumOf { (it - mean) * (it - mean) } / closes.size)
  return Bollinger(mean, mean + 2 * deviation, mean - 2 * deviation)
}

internal fun indicatorVolatility(
  state: IndicatorAccumulator,
  returns: Int,
  interval: Duration,
): Double? {
  if (returns < 2) return null
  val bars = contiguousIndicatorTail(state.recent, returns + 1, interval) ?: return null
  val values = bars.zipWithNext { left, right -> ln(right.c / left.c) }
  val mean = values.average()
  return sqrt(values.sumOf { (it - mean) * (it - mean) } / values.size)
}

internal fun indicatorWeightedPrice(
  bars: List<MicroBarPayload>,
  sourceVwap: Boolean,
): Double? {
  val volume = bars.sumOf { it.v }
  if (volume == 0.0 || (sourceVwap && bars.any { it.v > 0 && it.vwap == null })) return null
  return bars.sumOf { (if (sourceVwap) it.vwap ?: 0.0 else it.c) * it.v } / volume
}
