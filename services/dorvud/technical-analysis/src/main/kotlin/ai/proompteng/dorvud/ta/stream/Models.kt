package ai.proompteng.dorvud.ta.stream

import java.time.Instant

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.InstantIsoSerializer
import ai.proompteng.dorvud.platform.Window

@Serializable
data class TradePayload(
  val p: Double,
  val s: Long,
  @Serializable(with = InstantIsoSerializer::class)
  val t: Instant,
)

@Serializable
data class QuotePayload(
  val bp: Double,
  val bs: Long,
  val ap: Double,
  val `as`: Long,
  @Serializable(with = InstantIsoSerializer::class)
  val t: Instant,
)

@Serializable
data class AlpacaBarPayload(
  @SerialName("o")
  val open: Double,
  @SerialName("h")
  val high: Double,
  @SerialName("l")
  val low: Double,
  @SerialName("c")
  val close: Double,
  @SerialName("v")
  val volume: Long,
  @SerialName("vw")
  val vwap: Double? = null,
  @SerialName("n")
  val tradeCount: Long? = null,
  @SerialName("t")
  val timestamp: String,
)

@Serializable
data class MicroBarPayload(
  val o: Double,
  val h: Double,
  val l: Double,
  val c: Double,
  val v: Double,
  val vwap: Double?,
  val count: Long,
  @Serializable(with = InstantIsoSerializer::class)
  val t: Instant,
)

@Serializable
data class TaSignalsPayload(
  val macd: Macd? = null,
  val ema: Ema? = null,
  val rsi14: Double? = null,
  val boll: Bollinger? = null,
  val vwap: Vwap? = null,
  val imbalance: Imbalance? = null,
  val vol_realized: RealizedVol? = null,
)

@Serializable
data class TaStatusPayload(
  @SerialName("watermark_lag_ms")
  val watermarkLagMs: Long? = null,
  @SerialName("last_event_ts")
  val lastEventTs: String? = null,
  val status: String = "ok",
  val heartbeat: Boolean = true,
)

@Serializable
data class Macd(
  val macd: Double,
  val signal: Double,
  val hist: Double,
)

@Serializable
data class Ema(
  val ema12: Double,
  val ema26: Double,
)

@Serializable
data class Bollinger(
  val mid: Double,
  val upper: Double,
  val lower: Double,
)

@Serializable
data class Vwap(
  val session: Double,
  val w5m: Double? = null,
)

@Serializable
data class Imbalance(
  val spread: Double,
  val bid_px: Double,
  val ask_px: Double,
  val bid_sz: Long,
  val ask_sz: Long,
)

@Serializable
data class RealizedVol(
  val w60s: Double,
)

/** Helper to copy envelope with a new payload but the same metadata. */
fun <T, R> Envelope<T>.withPayload(
  newPayload: R,
  window: Window? = this.window,
  seqOverride: Long? = null,
): Envelope<R> =
  Envelope(
    ingestTs = ingestTs,
    eventTs = eventTs,
    feed = feed,
    channel = channel,
    symbol = symbol,
    seq = seqOverride ?: seq,
    payload = newPayload,
    isFinal = isFinal,
    source = source,
    window = window,
    version = version,
  )

fun AlpacaBarPayload.toMicroBarPayload(): MicroBarPayload =
  MicroBarPayload(
    o = open,
    h = high,
    l = low,
    c = close,
    v = volume.toDouble(),
    vwap = vwap,
    count = tradeCount ?: 0L,
    t = Instant.parse(timestamp),
  )
