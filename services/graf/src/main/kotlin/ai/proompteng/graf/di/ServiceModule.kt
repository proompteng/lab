package ai.proompteng.graf.di

import ai.proompteng.graf.codex.CodexResearchActivities
import ai.proompteng.graf.codex.CodexResearchActivitiesImpl
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.codex.CodexResearchWorkflowImpl
import ai.proompteng.graf.codex.MinioArtifactFetcher
import ai.proompteng.graf.codex.MinioArtifactFetcherImpl
import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.TemporalConfig
import ai.proompteng.graf.services.GraphPersistence
import ai.proompteng.graf.services.GraphService
import io.temporal.worker.WorkerFactory
import org.koin.dsl.module

/**
 * Hosts the domain services plus the Temporal worker registration that keeps them alive.
 */
val serviceModule =
  module {
    single<GraphService> {
      GraphService(get())
    }

    single<GraphPersistence> {
      get()
    }

    single<MinioArtifactFetcher> {
      MinioArtifactFetcherImpl(get())
    }

    single<CodexResearchActivities> {
      CodexResearchActivitiesImpl(get(), get(), get(), get())
    }

    single {
      CodexResearchWorkflowImpl()
    }

    single {
      CodexResearchService(
        workflowClient = get(),
        taskQueue = get<TemporalConfig>().taskQueue,
        argoPollTimeoutSeconds = get<ArgoConfig>().pollTimeoutSeconds,
      )
    }

    single(createdAtStart = true) {
      startCodexWorker(get(), get(), get(), get())
    }
  }

private fun startCodexWorker(
  factory: WorkerFactory,
  config: TemporalConfig,
  activities: CodexResearchActivities,
  workflowImpl: CodexResearchWorkflowImpl,
) {
  val worker = factory.newWorker(config.taskQueue)
  worker.registerWorkflowImplementationTypes(CodexResearchWorkflowImpl::class.java)
  worker.registerActivitiesImplementations(activities)
  factory.start()
}
