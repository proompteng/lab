package ai.proompteng.dorvud.ta

import kotlinx.serialization.Serializable

@Serializable
data class MicroBar(
  val o: Double,
  val h: Double,
  val l: Double,
  val c: Double,
  val v: Long,
  val t: String,
)

@Serializable
data class SignalSnapshot(
  val rsi14: Double? = null,
  val macd: Macd? = null,
  val ema: Ema? = null,
)

@Serializable
data class Macd(val macd: Double, val signal: Double, val hist: Double)

@Serializable
data class Ema(val ema12: Double? = null, val ema26: Double? = null)
