package ai.proompteng.graf.runtime

import org.koin.core.Koin
import org.koin.core.KoinApplication
import org.koin.core.context.startKoin
import org.koin.core.context.stopKoin
import org.koin.core.scope.Scope
import org.koin.core.scope.get
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

object GrafKoin {
  private val started = AtomicBoolean(false)
  private lateinit var koinApplication: KoinApplication

  fun start() {
    if (started.compareAndSet(false, true)) {
      koinApplication =
        startKoin {
          modules(
            grafLifecycleModule(),
            grafConfigModule(),
            grafClientModule(),
            grafServiceModule(),
            grafRequestScopeModule(),
          )
        }
    }
  }

  fun ensureStarted() {
    if (!started.get()) {
      start()
    }
  }

  fun stop() {
    if (started.compareAndSet(true, false)) {
      runCatching { koin().get<GrafLifecycleRegistry>().shutdown() }
      stopKoin()
    }
  }

  fun koin(): Koin {
    check(started.get()) { "GrafKoin has not been started" }
    return koinApplication.koin
  }

  inline fun <reified T : Any> lazyInject(): Lazy<T> =
    lazy(LazyThreadSafetyMode.NONE) { koin().get<T>() }

  inline fun <reified T : Any> get(): T = koin().get()

  fun openRequestScope(): Scope {
    val scopeId = "graf-request-${'$'}{UUID.randomUUID()}"
    return koin().createScope(scopeId, GrafScopes.Request)
  }

  fun close(scope: Scope) {
    scope.close()
  }
}
