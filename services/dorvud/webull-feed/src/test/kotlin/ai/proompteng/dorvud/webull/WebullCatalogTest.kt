package ai.proompteng.dorvud.webull

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

class WebullCatalogTest {
  @Test
  fun `catalog keeps the entire listed universe including close only symbols without a configured symbol cap`() {
    val listed =
      (1..10_001).map {
        WebullInstrument(
          "S$it",
          "$it",
          "NYSE",
          if (it % 2 ==
            0
          ) {
            "OC"
          } else {
            "CO"
          },
          if (it % 3 == 0) "ETF" else "COMMON_STOCK",
        )
      }
    val excluded =
      listOf(WebullInstrument("OTC", "20000", "PK", "OC", "COMMON_STOCK"), WebullInstrument("OLD", "20001", "NYSE", "NT", "COMMON_STOCK"))
    val catalog = eligibleWebullCatalog(listed + excluded)
    assertEquals(10_001, catalog.symbols.size)
    assertEquals(10_003, catalog.discovered)
    assertEquals(mapOf("outside_nasdaq_basic" to 1, "inactive_instrument" to 1), catalog.exclusions)
    assertEquals(catalog.identity, eligibleWebullCatalog((listed + excluded).reversed()).identity)
    assertFails { eligibleWebullCatalog(listed + listed.first().copy(instrumentId = "different")) }
  }

  @Test
  fun `bar collection isolates invalid symbols instead of abandoning valid batch peers`() =
    runBlocking {
      val captured = mutableListOf<String>()
      val invalid = mutableListOf<String>()
      collectWebullBarBatch(listOf("AAPL", "INVALID", "SPY"), { batch ->
        if ("INVALID" in batch) throw WebullApiFailure(417, "INVALID_SYMBOL", null)
        captured += batch
      }, invalid::add)
      assertEquals(listOf("AAPL", "SPY"), captured)
      assertEquals(listOf("INVALID"), invalid)
    }
}
