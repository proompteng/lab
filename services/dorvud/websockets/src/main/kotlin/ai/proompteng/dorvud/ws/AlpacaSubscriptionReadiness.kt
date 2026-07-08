package ai.proompteng.dorvud.ws

internal fun AlpacaSubscription.subscribedSymbolsForChannels(channels: Collection<String>): Set<String> =
  subscribedSymbolsByChannel(channels).values.flatten().toSet()

internal fun AlpacaSubscription.subscribedSymbolsByChannel(channels: Collection<String>): Map<String, Set<String>> {
  val normalizedChannels = channels.mapNotNull(::canonicalMarketDataChannel).toSet()
  return normalizedChannels.associateWith { channel ->
    val subscribed =
      when (channel) {
        "trades" -> trades
        "quotes" -> quotes
        "bars" -> bars1m
        "updatedBars" -> updatedBars
        else -> emptyList()
      }
    subscribed.map { it.trim().uppercase() }.filter { it.isNotEmpty() }.toSet()
  }
}

internal fun AlpacaSubscription.toMarketDataWebsocketStatus(
  previous: AlpacaMarketDataWebsocketStatus,
  channels: Collection<String>,
  desiredSymbols: Collection<String>,
  authOk: Boolean,
  nowMs: Long,
): AlpacaMarketDataWebsocketStatus {
  val subscribedByChannel = subscribedSymbolsByChannel(channels)
  val subscribedSymbols =
    subscribedByChannel
      .values
      .flatten()
      .toSet()
      .sorted()
  val missingByChannel = missingDesiredSymbolsByChannel(desiredSymbols, subscribedByChannel, channels)
  val subscriptionOk = subscribedSymbols.isNotEmpty() && missingByChannel.isEmpty()
  return previous.copy(
    authOk = authOk,
    subscriptionOk = subscriptionOk,
    latestSubscriptionAckAtMs = nowMs,
    subscribedSymbolCount = subscribedSymbols.size,
    subscribedSymbols = subscribedSymbols,
    subscribedSymbolsByChannel = subscribedByChannel.mapValues { (_, symbols) -> symbols.sorted() },
    missingSubscriptionSymbolsByChannel = missingByChannel,
    errorClass = if (authOk && subscriptionOk) null else previous.errorClass,
  )
}

internal fun missingDesiredSymbols(
  desired: Collection<String>,
  subscribed: Set<String>,
): List<String> {
  val normalizedSubscribed = subscribed.map { it.trim().uppercase() }.filter { it.isNotEmpty() }.toSet()
  return desired.map { it.trim().uppercase() }.filter { it.isNotEmpty() && it !in normalizedSubscribed }.distinct()
}

internal fun missingDesiredSymbolsByChannel(
  desired: Collection<String>,
  subscribedByChannel: Map<String, Set<String>>,
  channels: Collection<String>,
): Map<String, List<String>> {
  val normalizedDesired = desired.map { it.trim().uppercase() }.filter { it.isNotEmpty() }.distinct()
  return channels
    .mapNotNull(::canonicalMarketDataChannel)
    .distinct()
    .mapNotNull { channel ->
      val subscribed = subscribedByChannel[channel].orEmpty()
      val missing = normalizedDesired.filter { it !in subscribed }
      if (missing.isEmpty()) null else channel to missing
    }.toMap()
}

internal enum class SubscriptionAction {
  Unsubscribe,
  Subscribe,
}

internal data class SubscriptionUpdate(
  val action: SubscriptionAction,
  val symbols: List<String>,
)

internal fun subscriptionUpdates(
  desired: Collection<String>,
  subscribed: Collection<String>,
): List<SubscriptionUpdate> {
  val normalizedDesired = desired.map { it.trim().uppercase() }.filter { it.isNotEmpty() }.distinct()
  val normalizedSubscribed = subscribed.map { it.trim().uppercase() }.filter { it.isNotEmpty() }.distinct()
  val desiredSet = normalizedDesired.toSet()
  val subscribedSet = normalizedSubscribed.toSet()
  val removed = normalizedSubscribed.filter { it !in desiredSet }
  val added = normalizedDesired.filter { it !in subscribedSet }
  return listOfNotNull(
    removed.takeIf { it.isNotEmpty() }?.let { SubscriptionUpdate(SubscriptionAction.Unsubscribe, it) },
    added.takeIf { it.isNotEmpty() }?.let { SubscriptionUpdate(SubscriptionAction.Subscribe, it) },
  )
}
