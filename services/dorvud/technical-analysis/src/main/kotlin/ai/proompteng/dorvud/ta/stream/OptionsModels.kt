package ai.proompteng.dorvud.ta.stream

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.math.abs

@Serializable
data class OptionsTradePayload(
  @SerialName("contract_symbol")
  val contractSymbol: String,
  @SerialName("underlying_symbol")
  val underlyingSymbol: String,
  val price: Double,
  val size: Double,
  val exchange: String? = null,
  @SerialName("trade_id")
  val tradeId: String? = null,
  val conditions: List<String>? = null,
  val tape: String? = null,
  @SerialName("participant_ts")
  val participantTs: String,
  @SerialName("receipt_ts")
  val receiptTs: String,
  @SerialName("schema_version")
  val schemaVersion: Int = 1,
)

@Serializable
data class OptionsQuotePayload(
  @SerialName("contract_symbol")
  val contractSymbol: String,
  @SerialName("underlying_symbol")
  val underlyingSymbol: String,
  @SerialName("bid_price")
  val bidPrice: Double,
  @SerialName("bid_size")
  val bidSize: Double,
  @SerialName("ask_price")
  val askPrice: Double,
  @SerialName("ask_size")
  val askSize: Double,
  @SerialName("bid_exchange")
  val bidExchange: String? = null,
  @SerialName("ask_exchange")
  val askExchange: String? = null,
  @SerialName("quote_condition")
  val quoteCondition: String? = null,
  @SerialName("participant_ts")
  val participantTs: String,
  @SerialName("receipt_ts")
  val receiptTs: String,
  @SerialName("schema_version")
  val schemaVersion: Int = 1,
)

@Serializable
data class OptionsSnapshotPayload(
  @SerialName("contract_symbol")
  val contractSymbol: String,
  @SerialName("underlying_symbol")
  val underlyingSymbol: String,
  @SerialName("latest_trade_price")
  val latestTradePrice: Double? = null,
  @SerialName("latest_trade_size")
  val latestTradeSize: Double? = null,
  @SerialName("latest_trade_ts")
  val latestTradeTs: String? = null,
  @SerialName("latest_bid_price")
  val latestBidPrice: Double? = null,
  @SerialName("latest_bid_size")
  val latestBidSize: Double? = null,
  @SerialName("latest_ask_price")
  val latestAskPrice: Double? = null,
  @SerialName("latest_ask_size")
  val latestAskSize: Double? = null,
  @SerialName("latest_quote_ts")
  val latestQuoteTs: String? = null,
  @SerialName("implied_volatility")
  val impliedVolatility: Double? = null,
  val delta: Double? = null,
  val gamma: Double? = null,
  val theta: Double? = null,
  val vega: Double? = null,
  val rho: Double? = null,
  @SerialName("open_interest")
  val openInterest: Long? = null,
  @SerialName("open_interest_date")
  val openInterestDate: String? = null,
  @SerialName("mark_price")
  val markPrice: Double? = null,
  @SerialName("mid_price")
  val midPrice: Double? = null,
  @SerialName("snapshot_class")
  val snapshotClass: String,
  @SerialName("source_window_start_ts")
  val sourceWindowStartTs: String? = null,
  @SerialName("source_window_end_ts")
  val sourceWindowEndTs: String? = null,
  @SerialName("schema_version")
  val schemaVersion: Int = 1,
)

@Serializable
data class OptionsContractBarPayload(
  @SerialName("underlying_symbol")
  val underlyingSymbol: String,
  @SerialName("expiration_date")
  val expirationDate: String,
  @SerialName("strike_price")
  val strikePrice: Double,
  @SerialName("option_type")
  val optionType: String,
  val dte: Int,
  val o: Double,
  val h: Double,
  val l: Double,
  val c: Double,
  val v: Double,
  val count: Long,
  @SerialName("bid_close")
  val bidClose: Double? = null,
  @SerialName("ask_close")
  val askClose: Double? = null,
  @SerialName("mid_close")
  val midClose: Double? = null,
  @SerialName("mark_close")
  val markClose: Double? = null,
  @SerialName("spread_abs")
  val spreadAbs: Double? = null,
  @SerialName("spread_bps")
  val spreadBps: Double? = null,
  @SerialName("bid_size_close")
  val bidSizeClose: Double? = null,
  @SerialName("ask_size_close")
  val askSizeClose: Double? = null,
)

@Serializable
data class OptionsContractFeaturePayload(
  @SerialName("underlying_symbol")
  val underlyingSymbol: String,
  @SerialName("expiration_date")
  val expirationDate: String,
  @SerialName("strike_price")
  val strikePrice: Double,
  @SerialName("option_type")
  val optionType: String,
  val dte: Int,
  val moneyness: Double? = null,
  @SerialName("spread_abs")
  val spreadAbs: Double? = null,
  @SerialName("spread_bps")
  val spreadBps: Double? = null,
  @SerialName("bid_size")
  val bidSize: Double? = null,
  @SerialName("ask_size")
  val askSize: Double? = null,
  @SerialName("quote_imbalance")
  val quoteImbalance: Double? = null,
  @SerialName("trade_count_w60s")
  val tradeCountW60s: Long? = null,
  @SerialName("notional_w60s")
  val notionalW60s: Double? = null,
  @SerialName("quote_updates_w60s")
  val quoteUpdatesW60s: Long? = null,
  @SerialName("realized_vol_w60s")
  val realizedVolW60s: Double? = null,
  @SerialName("implied_volatility")
  val impliedVolatility: Double? = null,
  @SerialName("iv_change_w60s")
  val ivChangeW60s: Double? = null,
  val delta: Double? = null,
  @SerialName("delta_change_w60s")
  val deltaChangeW60s: Double? = null,
  val gamma: Double? = null,
  val theta: Double? = null,
  val vega: Double? = null,
  val rho: Double? = null,
  @SerialName("mid_price")
  val midPrice: Double? = null,
  @SerialName("mark_price")
  val markPrice: Double? = null,
  @SerialName("mid_change_w60s")
  val midChangeW60s: Double? = null,
  @SerialName("mark_change_w60s")
  val markChangeW60s: Double? = null,
  @SerialName("stale_quote")
  val staleQuote: Boolean,
  @SerialName("stale_snapshot")
  val staleSnapshot: Boolean,
  @SerialName("feature_quality_status")
  val featureQualityStatus: String,
)

@Serializable
data class OptionsSurfaceFeaturePayload(
  @SerialName("underlying_symbol")
  val underlyingSymbol: String,
  @SerialName("asof_contract_count")
  val asofContractCount: Int,
  @SerialName("atm_iv")
  val atmIv: Double? = null,
  @SerialName("atm_call_iv")
  val atmCallIv: Double? = null,
  @SerialName("atm_put_iv")
  val atmPutIv: Double? = null,
  @SerialName("call_put_skew_25d")
  val callPutSkew25d: Double? = null,
  @SerialName("call_put_skew_10d")
  val callPutSkew10d: Double? = null,
  @SerialName("term_slope_front_back")
  val termSlopeFrontBack: Double? = null,
  @SerialName("term_slope_front_mid")
  val termSlopeFrontMid: Double? = null,
  @SerialName("surface_breadth")
  val surfaceBreadth: Double? = null,
  @SerialName("hot_contract_coverage_ratio")
  val hotContractCoverageRatio: Double? = null,
  @SerialName("snapshot_coverage_ratio")
  val snapshotCoverageRatio: Double? = null,
  @SerialName("feature_quality_status")
  val featureQualityStatus: String,
)

@Serializable
data class OptionsTaStatusPayload(
  val component: String,
  val status: String,
  @SerialName("watermark_lag_ms")
  val watermarkLagMs: Long? = null,
  @SerialName("last_event_ts")
  val lastEventTs: String? = null,
  @SerialName("checkpoint_age_ms")
  val checkpointAgeMs: Long? = null,
  @SerialName("input_backlog")
  val inputBacklog: Long? = null,
  @SerialName("schema_version")
  val schemaVersion: Int = 1,
)

data class OptionsContractIdentity(
  val contractSymbol: String,
  val underlyingSymbol: String,
  val expirationDate: LocalDate,
  val strikePrice: Double,
  val optionType: String,
)

private val occSymbolRegex = Regex("^([A-Z]{1,6})(\\d{2})(\\d{2})(\\d{2})([CP])(\\d{8})$")

fun parseOptionsContractIdentity(
  contractSymbol: String,
  fallbackUnderlyingSymbol: String? = null,
): OptionsContractIdentity? {
  val match = occSymbolRegex.matchEntire(contractSymbol) ?: return null
  val year = 2000 + match.groupValues[2].toInt()
  val month = match.groupValues[3].toInt()
  val day = match.groupValues[4].toInt()
  val optionType = if (match.groupValues[5] == "C") "call" else "put"
  val strikePrice = match.groupValues[6].toDouble() / 1000.0
  return runCatching {
    OptionsContractIdentity(
      contractSymbol = contractSymbol,
      underlyingSymbol = fallbackUnderlyingSymbol ?: match.groupValues[1],
      expirationDate = LocalDate.of(year, month, day),
      strikePrice = strikePrice,
      optionType = optionType,
    )
  }.getOrNull()
}

fun optionsDte(
  expirationDate: String,
  asOf: Instant,
): Int {
  val expiration = runCatching { LocalDate.parse(expirationDate) }.getOrNull() ?: return 0
  return (expiration.toEpochDay() - asOf.atZone(ZoneOffset.UTC).toLocalDate().toEpochDay()).toInt()
}

fun parseInstantOrNull(value: String?): Instant? = value?.let { runCatching { Instant.parse(it) }.getOrNull() }

fun OptionsSnapshotPayload.referencePrice(): Double? = markPrice ?: midPrice ?: latestTradePrice

fun computeMoneyness(
  strikePrice: Double,
  referencePrice: Double?,
): Double? {
  if (referencePrice == null || referencePrice <= 0.0 || strikePrice <= 0.0) {
    return null
  }
  return abs((strikePrice - referencePrice) / referencePrice)
}
