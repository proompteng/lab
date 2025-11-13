package ai.proompteng.graf.runtime

import ai.proompteng.graf.autoresearch.AutoResearchLauncher
import ai.proompteng.graf.services.GraphService
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import kotlin.test.assertNotNull
import kotlin.test.assertSame

class GrafKoinModulesTest {
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
  fun `graph service resolves as singleton`() {
    val koin = GrafKoin.koin()
    val first = koin.get<GraphService>()
    val second = koin.get<GraphService>()
    assertSame(first, second)
  }

  @Test
  fun `auto research launcher is available`() {
    val launcher = GrafKoin.koin().get<AutoResearchLauncher>()
    assertNotNull(launcher)
  }
}
