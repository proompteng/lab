package ai.proompteng.dorvud.ws

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

enum class EquityFeed(
  val id: String,
  val apiVersion: String,
  val observationOnly: Boolean,
) {
  Iex("iex", "v2", false),
  Sip("sip", "v2", false),
  DelayedSip("delayed_sip", "v2", true),
  Overnight("overnight", "v1beta1", true),
  ;

  companion object {
    fun parse(value: String): EquityFeed =
      entries.firstOrNull { it.id == value.trim().lowercase() }
        ?: error("unsupported Alpaca equity feed: $value")
  }
}

enum class MarketSession(
  val id: String,
) {
  Overnight("overnight"),
  Premarket("pre"),
  Regular("regular"),
  AfterHours("post"),
}

enum class MarketDataDelayClass(
  val id: String,
) {
  RealTimeExchangeOnly("real_time_exchange_only"),
  RealTimeConsolidated("real_time_consolidated"),
  Delayed15MinuteConsolidated("delayed_15m_consolidated"),
  IndicativeRealTime("indicative_real_time"),
  Delayed15MinuteAdjusted("delayed_15m_adjusted"),
  Derived("derived"),
}

data class ObservationFeedConfig(
  val feed: EquityFeed,
  val topics: TopicConfig,
)

data class FeedRuntimeConfig(
  val feed: String,
  val equityFeed: EquityFeed?,
  val channels: List<String>,
  val topics: TopicConfig,
  val symbols: List<String>,
  val symbolAllowlist: Set<String>,
  val core: Boolean,
)

internal fun FeedRuntimeConfig.topicFor(
  channel: String,
  marketType: AlpacaMarketType,
): String? =
  when (canonicalMarketDataChannel(channel)) {
    "trades" -> topics.trades
    "quotes" -> topics.quotes
    "bars", "updatedBars" -> topics.bars1m
    else -> if (channel == "status" && marketType != AlpacaMarketType.OPTIONS) topics.status else null
  }

private val marketSessionZone: ZoneId = ZoneId.of("America/New_York")
private val overnightClose: LocalTime = LocalTime.of(4, 0)
private val regularOpen: LocalTime = LocalTime.of(9, 30)
private val regularClose: LocalTime = LocalTime.of(16, 0)
private val overnightOpen: LocalTime = LocalTime.of(20, 0)

internal fun classifyMarketSession(eventTime: Instant): MarketSession {
  val localTime = eventTime.atZone(marketSessionZone).toLocalTime()
  return when {
    localTime < overnightClose -> MarketSession.Overnight
    localTime < regularOpen -> MarketSession.Premarket
    localTime < regularClose -> MarketSession.Regular
    localTime < overnightOpen -> MarketSession.AfterHours
    else -> MarketSession.Overnight
  }
}

internal fun marketDataDelayClass(
  feed: EquityFeed,
  channel: String,
): MarketDataDelayClass {
  val canonicalChannel =
    canonicalMarketDataChannel(channel)
      ?: error("unsupported market-data channel for ${feed.id}: $channel")
  return when (feed) {
    EquityFeed.Iex -> MarketDataDelayClass.RealTimeExchangeOnly
    EquityFeed.Sip -> MarketDataDelayClass.RealTimeConsolidated
    EquityFeed.DelayedSip -> MarketDataDelayClass.Delayed15MinuteConsolidated
    EquityFeed.Overnight ->
      when (canonicalChannel) {
        "quotes" -> MarketDataDelayClass.IndicativeRealTime
        "trades" -> MarketDataDelayClass.Delayed15MinuteAdjusted
        "bars", "updatedBars" -> MarketDataDelayClass.Derived
        else -> error("unsupported overnight channel: $canonicalChannel")
      }
  }
}

internal fun ForwarderConfig.marketDataFeedConfigs(): List<FeedRuntimeConfig> {
  val coreEquityFeed =
    if (alpacaMarketType == AlpacaMarketType.EQUITY) {
      EquityFeed.parse(alpacaFeed)
    } else {
      null
    }
  val core =
    FeedRuntimeConfig(
      feed = alpacaFeed,
      equityFeed = coreEquityFeed,
      channels = alpacaMarketDataChannels,
      topics = topics,
      symbols = staticSymbols,
      symbolAllowlist = symbolAllowlist,
      core = true,
    )
  return listOf(core) +
    observationFeeds.map { observation ->
      FeedRuntimeConfig(
        feed = observation.feed.id,
        equityFeed = observation.feed,
        channels = defaultAlpacaMarketDataChannels(AlpacaMarketType.EQUITY),
        topics = observation.topics,
        symbols = observationSymbols,
        symbolAllowlist = emptySet(),
        core = false,
      )
    }
}
