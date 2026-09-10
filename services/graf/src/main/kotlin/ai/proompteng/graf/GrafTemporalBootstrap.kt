package ai.proompteng.graf

import ai.proompteng.graf.codex.CodexResearchActivities
import ai.proompteng.graf.codex.CodexResearchWorkflowImpl
import ai.proompteng.graf.config.TemporalConfig
import ai.proompteng.graf.runtime.GrafKoin
import ai.proompteng.graf.runtime.GrafLifecycleRegistry
import ai.proompteng.graf.telemetry.GrafTelemetry
import io.temporal.serviceclient.WorkflowServiceStubs
import io.temporal.worker.WorkerFactory
import java.util.concurrent.atomic.AtomicBoolean

object GrafTemporalBootstrap {
  private val started = AtomicBoolean(false)

  fun start() {
    if (!started.compareAndSet(false, true)) {
      return
    }
    val koin = GrafKoin.koin()
    val workerFactory = koin.get<WorkerFactory>()
    val temporalConfig = koin.get<TemporalConfig>()
    val activities = koin.get<CodexResearchActivities>()
    val serviceStubs = koin.get<WorkflowServiceStubs>()

    val worker = workerFactory.newWorker(temporalConfig.taskQueue)
    worker.registerWorkflowImplementationTypes(CodexResearchWorkflowImpl::class.java)
    worker.registerActivitiesImplementations(activities)
    workerFactory.start()

    koin.get<GrafLifecycleRegistry>().register {
      workerFactory.shutdown()
      serviceStubs.shutdown()
      GrafTelemetry.shutdown()
    }
  }

  fun stop() {
    if (started.compareAndSet(true, false)) {
      runCatching {
        val koin = GrafKoin.koin()
        koin.get<WorkerFactory>().shutdown()
        koin.get<WorkflowServiceStubs>().shutdown()
      }
    }
  }
}
