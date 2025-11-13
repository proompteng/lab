package ai.proompteng.graf.runtime

import ai.proompteng.graf.autoresearch.AutoResearchLauncher
import ai.proompteng.graf.codex.ArgoWorkflowClient
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.services.GraphService
import io.minio.MinioClient
import io.temporal.client.WorkflowClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import mu.KotlinLogging
import org.koin.core.scope.get

object GrafWarmup {
  private val logger = KotlinLogging.logger {}

  fun prime() {
    runBlocking {
      val koin = GrafKoin.koin()
      val tasks =
        listOf(
          async(Dispatchers.Default) { koin.get<GraphService>() },
          async(Dispatchers.Default) { koin.get<AutoResearchLauncher>() },
          async(Dispatchers.Default) { koin.get<CodexResearchService>() },
          async(Dispatchers.Default) { koin.get<ArgoWorkflowClient>() },
          async(Dispatchers.Default) { koin.get<WorkflowClient>() },
          async(Dispatchers.Default) { koin.get<MinioClient>() },
        )
      tasks.awaitAll()

      runCatching {
        koin.get<GraphService>().warmup()
      }.onFailure { error ->
        logger.warn(error) { "GraphService warmup failed; first request may perform lazy initialization" }
      }

      runCatching {
        val scope = GrafKoin.openRequestScope()
        scope.get<GrafRequestContext>()
        GrafKoin.close(scope)
      }.onFailure { error ->
        logger.warn(error) { "Request scope warmup failed" }
      }
    }
  }
}
