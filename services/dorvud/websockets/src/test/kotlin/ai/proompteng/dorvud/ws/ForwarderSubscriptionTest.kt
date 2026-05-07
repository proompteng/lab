package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertEquals

class ForwarderSubscriptionTest {
  @Test
  fun `subscribed symbols are derived from Alpaca acknowledgement channels`() {
    val ack =
      AlpacaSubscription(
        trades = listOf("nvda", "AAPL"),
        quotes = listOf("NVDA", "AMZN"),
        bars1m = listOf("AVGO"),
        updatedBars = listOf("AMD", " "),
      )

    assertEquals(
      setOf("NVDA", "AAPL", "AMZN", "AVGO", "AMD"),
      ack.subscribedSymbolsForChannels(listOf("trades", "quotes", "bars", "updatedBars")),
    )
    assertEquals(
      setOf("NVDA", "AMZN"),
      ack.subscribedSymbolsForChannels(listOf("quotes")),
    )
  }

  @Test
  fun `missing desired symbols stay retryable after partial Alpaca acknowledgement`() {
    val desired = listOf("NVDA", "AAPL", "AMZN", "GOOGL", "AVGO", "AMD", "ORCL", "INTC")
    val actual =
      AlpacaSubscription(
        trades = listOf("NVDA", "AMD", "AVGO", "INTC"),
        quotes = listOf("NVDA", "AMD", "AVGO", "INTC"),
        bars1m = listOf("NVDA", "AMD", "AVGO", "INTC"),
        updatedBars = listOf("NVDA", "AMD", "AVGO", "INTC"),
      ).subscribedSymbolsForChannels(listOf("trades", "quotes", "bars", "updatedBars"))

    assertEquals(listOf("AAPL", "AMZN", "GOOGL", "ORCL"), missingDesiredSymbols(desired, actual))
  }
}
