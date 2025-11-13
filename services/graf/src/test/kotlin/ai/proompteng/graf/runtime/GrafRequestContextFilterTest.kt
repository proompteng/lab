package ai.proompteng.graf.runtime

import io.mockk.every
import io.mockk.mockk
import jakarta.ws.rs.container.ContainerRequestContext
import jakarta.ws.rs.container.ContainerResponseContext
import jakarta.ws.rs.core.MultivaluedHashMap
import jakarta.ws.rs.core.UriInfo
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.koin.core.scope.Scope
import kotlin.test.assertEquals
import kotlin.test.assertNull

private const val SCOPE_KEY = "graf.request.scope"

class GrafRequestContextFilterTest {
  companion object {
    @BeforeAll
    @JvmStatic
    fun startKoin() {
      GrafKoin.start()
    }

    @AfterAll
    @JvmStatic
    fun stopKoin() {
      GrafKoin.stop()
    }
  }

  @Test
  fun `request scope captures headers and detaches`() {
    val filter = GrafRequestContextFilter()
    val headers =
      MultivaluedHashMap<String, String>().apply {
        add("X-Request-Id", "req-123")
        add("Authorization", "Bearer fast-token")
      }
    val requestContext = mockk<ContainerRequestContext>(relaxed = true)
    val responseContext = mockk<ContainerResponseContext>(relaxed = true)
    val uriInfo = mockk<UriInfo>(relaxed = true)
    every { uriInfo.path } returns "/v1/entities"
    every { requestContext.uriInfo } returns uriInfo
    every { requestContext.headers } returns headers
    val properties = mutableMapOf<String, Any?>()
    every { requestContext.setProperty(any(), any()) } answers {
      properties[firstArg<String>()] = secondArg()
    }
    every { requestContext.getProperty(any()) } answers {
      properties[firstArg<String>()]
    }

    filter.filter(requestContext)

    val context = GrafRequestContextHolder.get()
    assertEquals("req-123", context?.requestId)
    assertEquals("fast-token", context?.bearerPrincipal)
    val scope = properties[SCOPE_KEY]
    check(scope is Scope)

    filter.filter(requestContext, responseContext)

    assertNull(GrafRequestContextHolder.get())
    assertNull(properties[SCOPE_KEY])
  }
}
