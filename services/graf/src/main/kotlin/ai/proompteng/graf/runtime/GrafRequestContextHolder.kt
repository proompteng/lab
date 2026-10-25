package ai.proompteng.graf.runtime

object GrafRequestContextHolder {
  private val current = ThreadLocal<GrafRequestContext?>()

  fun attach(context: GrafRequestContext) {
    current.set(context)
  }

  fun get(): GrafRequestContext? = current.get()

  fun detach() {
    current.remove()
  }
}
