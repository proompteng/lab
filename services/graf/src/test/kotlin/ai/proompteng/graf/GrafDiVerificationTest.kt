package ai.proompteng.graf

import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.di.GrafRequestContext
import ai.proompteng.graf.services.GraphService
import io.quarkus.arc.Arc
import io.quarkus.test.junit.QuarkusTest
import jakarta.inject.Inject
import kotlin.test.Test
import kotlin.test.assertNotNull

@QuarkusTest
class GrafDiVerificationTest {
  @Inject
  lateinit var graphService: GraphService

  @Inject
  lateinit var codexResearchService: CodexResearchService

  @Test
  fun `core CDI beans are available`() {
    assertNotNull(graphService)
    assertNotNull(codexResearchService)

    val requestContextController = Arc.container().requestContext()
    requestContextController.activate()
    try {
      val grafRequestContext = Arc.container().instance(GrafRequestContext::class.java).get()
      assertNotNull(grafRequestContext.requestId)
    } finally {
      requestContextController.deactivate()
    }
  }
}
