package ai.proompteng.graf

import ai.proompteng.graf.runtime.GrafKoin
import ai.proompteng.graf.runtime.GrafWarmup
import io.quarkus.runtime.Quarkus
import io.quarkus.runtime.annotations.QuarkusMain

@QuarkusMain
object GrafApplication {
  @JvmStatic
  fun main(args: Array<String>) {
    GrafKoin.start()
    GrafWarmup.prime()
    GrafTemporalBootstrap.start()
    Runtime.getRuntime().addShutdownHook(
      Thread {
        GrafTemporalBootstrap.stop()
        GrafKoin.stop()
      },
    )
    Quarkus.run(*args)
  }
}
