package ai.proompteng.graf.security

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ApiBearerTokenConfigTest {
  @Test
  fun `isValid matches tokens loaded at startup`() {
    System.setProperty("GRAF_API_BEARER_TOKENS", "alpha beta")
    try {
      ApiBearerTokenConfig.overrideTokensForTests(setOf("alpha", "beta"))

      assertTrue(ApiBearerTokenConfig.isValid("alpha"))
      assertFalse(ApiBearerTokenConfig.isValid("missing"))
    } finally {
      System.clearProperty("GRAF_API_BEARER_TOKENS")
    }
  }
}
