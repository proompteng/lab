package ai.proompteng.graf.di

import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.services.GraphService
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.koin.dsl.koinApplication

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ModulesTest {
  private val moduleList =
    listOf(configModule, infrastructureModule, serviceModule, standardTestOverrides)

  private val koinApp =
    koinApplication {
      allowOverride(true)
    }.apply {
      modules(moduleList)
    }

  @AfterAll
  fun tearDown() {
    koinApp.close()
  }

  @Test
  fun `koin modules resolve`() {
    assertNotNull(koinApp.koin.get<GraphService>())
    assertNotNull(koinApp.koin.get<CodexResearchService>())
  }
}
