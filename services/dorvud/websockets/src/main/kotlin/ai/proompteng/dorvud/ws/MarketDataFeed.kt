package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.CRYPTO_LOCATIONS
import ai.proompteng.dorvud.platform.isCryptoPair
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

enum class EquityFeed(
  val id: String,
  val apiVersion: String,
) {
  Iex("iex", "v2"),
  Sip("sip", "v2"),
  DelayedSip("delayed_sip", "v2"),
  Overnight("overnight", "v1beta1"),
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
  val marketType: AlpacaMarketType,
  val feed: String,
  val equityFeed: EquityFeed?,
  val channels: List<String>,
  val topics: TopicConfig,
  val symbols: List<String>,
  val symbolOverridesByChannel: Map<String, List<String>> = emptyMap(),
  val symbolAllowlist: Set<String>,
  val core: Boolean,
  val cryptoEventsTopic: String? = null,
)

data class CryptoFeedConfig(
  val location: String,
  val symbols: List<String>,
  val topic: String,
) {
  companion object {
    fun fromEnv(
      env: Map<String, String>,
      marketType: AlpacaMarketType,
      coreSymbols: List<String>,
    ): CryptoFeedConfig? {
      val rawSymbols = env["ALPACA_CRYPTO_SYMBOLS"]
      if (rawSymbols == null && marketType != AlpacaMarketType.CRYPTO) return null
      require(marketType != AlpacaMarketType.OPTIONS) { "crypto and options streams require separate forwarders" }
      val symbols = (rawSymbols?.split(",") ?: coreSymbols).map { it.trim().uppercase() }
      require(symbols.isNotEmpty() && symbols.all(::isCryptoPair) && symbols.distinct().size == symbols.size) {
        "ALPACA_CRYPTO_SYMBOLS must contain unique BASE/QUOTE pairs"
      }
      val location = env["ALPACA_CRYPTO_LOCATION"]?.trim()?.lowercase() ?: "us"
      require(location in CRYPTO_LOCATIONS) { "unsupported ALPACA_CRYPTO_LOCATION" }
      val topic = requireNotNull(env["TOPIC_CRYPTO_EVENTS"]?.trim()?.takeIf { it.isNotEmpty() }) { "TOPIC_CRYPTO_EVENTS must be set" }
      return CryptoFeedConfig(location, symbols, topic)
    }
  }
}

internal fun FeedRuntimeConfig.desiredSymbolsByChannel(symbols: Collection<String>): Map<String, List<String>> {
  val normalized = symbols.map { it.trim().uppercase() }.filter { it.isNotEmpty() }.distinct()
  return channels.associateWith { channel -> symbolOverridesByChannel[channel] ?: normalized }
}

internal fun FeedRuntimeConfig.topicFor(channel: String): String? =
  cryptoEventsTopic ?: when (canonicalMarketDataChannel(channel)) {
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
      marketType = alpacaMarketType,
      feed = if (alpacaMarketType == AlpacaMarketType.CRYPTO) requireNotNull(cryptoFeed).location else alpacaFeed,
      equityFeed = coreEquityFeed,
      channels = alpacaMarketDataChannels,
      topics = topics,
      symbols = if (alpacaMarketType == AlpacaMarketType.CRYPTO) requireNotNull(cryptoFeed).symbols else staticSymbols,
      symbolOverridesByChannel = alpacaMarketDataSymbolOverrides,
      symbolAllowlist = symbolAllowlist,
      core = true,
      cryptoEventsTopic = cryptoFeed?.takeIf { alpacaMarketType == AlpacaMarketType.CRYPTO }?.topic,
    )
  return listOf(core) +
    observationFeeds.map { observation ->
      FeedRuntimeConfig(
        marketType = AlpacaMarketType.EQUITY,
        feed = observation.feed.id,
        equityFeed = observation.feed,
        channels = defaultAlpacaMarketDataChannels(AlpacaMarketType.EQUITY),
        topics = observation.topics,
        symbols = observationSymbols,
        symbolAllowlist = emptySet(),
        core = false,
      )
    } +
    listOfNotNull(
      cryptoFeed?.takeIf { alpacaMarketType != AlpacaMarketType.CRYPTO }?.let { crypto ->
        FeedRuntimeConfig(
          marketType = AlpacaMarketType.CRYPTO,
          feed = crypto.location,
          equityFeed = null,
          channels = defaultAlpacaMarketDataChannels(AlpacaMarketType.CRYPTO),
          topics = topics,
          symbols = crypto.symbols,
          symbolAllowlist = crypto.symbols.toSet(),
          core = false,
          cryptoEventsTopic = crypto.topic,
        )
      },
    )
}
