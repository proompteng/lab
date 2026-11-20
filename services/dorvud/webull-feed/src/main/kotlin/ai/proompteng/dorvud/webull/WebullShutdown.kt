package ai.proompteng.dorvud.webull

import kotlinx.coroutines.Job

internal suspend fun drainWebullPublisher(
  ingress: Job,
  input: WebullPublisher,
  publisher: Job,
) {
  val inputs = ingress.children.toList()
  inputs.forEach { it.cancel() }
  inputs.forEach { it.join() }
  input.close()
  publisher.join()
}
