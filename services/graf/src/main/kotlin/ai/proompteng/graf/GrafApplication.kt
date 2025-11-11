package ai.proompteng.graf

import io.quarkus.runtime.Quarkus
import io.quarkus.runtime.annotations.QuarkusMain

@QuarkusMain
object GrafApplication {
  @JvmStatic
  fun main(args: Array<String>) {
    Quarkus.run(*args)
  }
}
