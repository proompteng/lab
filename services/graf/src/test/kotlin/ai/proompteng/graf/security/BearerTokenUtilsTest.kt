package ai.proompteng.graf.security

import io.mockk.every
import io.mockk.mockk
import jakarta.ws.rs.NotAuthorizedException
import jakarta.ws.rs.container.ContainerRequestContext
import jakarta.ws.rs.core.MultivaluedHashMap
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class BearerTokenUtilsTest {
  @Test
  fun `parseBearerTokenValue handles prefixes`() {
    assertNull(parseBearerTokenValue(null))
    assertNull(parseBearerTokenValue("   "))
    assertEquals("abc", parseBearerTokenValue("Bearer abc"))
    assertEquals("token", parseBearerTokenValue("token"))
  }

  @Test
  fun `requireBearerToken extracts header`() {
    val context = stubContext("Bearer top-secret")

    assertEquals("top-secret", requireBearerToken(context))
  }

  @Test
  fun `requireBearerToken throws when missing or blank`() {
    val blankContext = stubContext("   ")
    assertFailsWith<NotAuthorizedException> {
      requireBearerToken(blankContext)
    }

    val missingContext = stubContext(null)
    assertFailsWith<NotAuthorizedException> {
      requireBearerToken(missingContext)
    }
  }

  private fun stubContext(token: String?): ContainerRequestContext {
    val headers = MultivaluedHashMap<String, String>()
    token?.let { headers.add("Authorization", it) }
    return mockk<ContainerRequestContext>().apply {
      every { getHeaders() } returns headers
      every { getHeaderString("Authorization") } answers { headers.getFirst("Authorization") }
    }
  }
}
