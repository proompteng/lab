package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.ta.di.taModule
import ai.proompteng.dorvud.ta.server.HttpServer
import ai.proompteng.dorvud.ta.stream.TechnicalAnalysisService
import kotlinx.coroutines.runBlocking
import org.koin.core.context.startKoin
import org.koin.core.context.stopKoin
import org.koin.java.KoinJavaComponent.getKoin

fun main() =
  runBlocking {
    startKoin { modules(taModule) }
    val koin = getKoin()
    val http = koin.get<HttpServer>()
    val service = koin.get<TechnicalAnalysisService>()

    http.start()
    val job = service.start()

    Runtime.getRuntime().addShutdownHook(
      Thread {
        runBlocking {
          http.stop()
          service.stop()
          stopKoin()
        }
      },
    )

    job.join()
  }
