package ai.proompteng.dorvud.hyperliquid

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class RateLimiterTest {
  @Test
  fun `tracks used weight in current window`() =
    runTest {
      var now = 0L
      val budget = MinuteWeightBudget(maxWeightPerMinute = 100) { now }

      budget.acquire(20)
      budget.acquire(30)
      assertEquals(50, budget.usedWeightInCurrentWindow())

      now = 60_001
      assertEquals(0, budget.usedWeightInCurrentWindow())
    }
}
