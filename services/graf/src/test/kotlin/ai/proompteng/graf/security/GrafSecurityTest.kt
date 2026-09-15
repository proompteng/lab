package ai.proompteng.graf.security

import ai.proompteng.graf.model.ErrorResponse
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import jakarta.ws.rs.NotAuthorizedException
import jakarta.ws.rs.container.ContainerRequestContext
import jakarta.ws.rs.core.MultivaluedHashMap
import jakarta.ws.rs.core.UriInfo
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class GrafSecurityTest {
  private val filter = GrafBearerTokenFilter()

  companion object {
    init {
      System.setProperty("GRAF_API_BEARER_TOKENS", "test-token")
    }
  }

  @AfterTest
  fun resetTokens() {
    ApiBearerTokenConfig.overrideTokensForTests(setOf())
  }

  @Test
  fun `filter ignores non v1 paths`() {
    val context = mockk<ContainerRequestContext>()
    val uriInfo = mockk<UriInfo>()
    every { context.uriInfo } returns uriInfo
    every { uriInfo.path } returns "healthz"

    filter.filter(context)

    verify(exactly = 0) { context.headers }
  }

  @Test
  fun `filter accepts valid bearer token`() {
    ApiBearerTokenConfig.overrideTokensForTests(setOf("token-ok"))
    val headers =
      MultivaluedHashMap<String, String>().apply {
        add("Authorization", "Bearer token-ok")
      }
    val context = mockk<ContainerRequestContext>()
    val uriInfo = mockk<UriInfo>()
    every { context.uriInfo } returns uriInfo
    every { uriInfo.path } returns "v1/entities"
    every { context.headers } returns headers

    filter.filter(context)
  }

  @Test
  fun `filter throws when token missing`() {
    ApiBearerTokenConfig.overrideTokensForTests(setOf("token-ok"))
    val headers =
      MultivaluedHashMap<String, String>()
    val context = mockk<ContainerRequestContext>()
    val uriInfo = mockk<UriInfo>()
    every { context.uriInfo } returns uriInfo
    every { uriInfo.path } returns "v1/entities"
    every { context.headers } returns headers

    assertFailsWith<NotAuthorizedException> {
      filter.filter(context)
    }
  }

  @Test
  fun `illegal argument mapper builds 400 response`() {
    val mapper = IllegalArgumentExceptionMapper()
    val response = mapper.toResponse(java.lang.IllegalArgumentException("bad input"))

    assertEquals(400, response.status)
    val payload = response.entity as ErrorResponse
    assertEquals("bad input", payload.error)
  }

  @Test
  fun `generic mapper hides internal errors`() {
    val mapper = GenericExceptionMapper()
    val response = mapper.toResponse(RuntimeException("boom"))

    assertEquals(500, response.status)
    val payload = response.entity as ErrorResponse
    assertEquals("internal server error", payload.error)
    assertTrue(response.mediaType.toString().contains("application/json"))
  }
}
