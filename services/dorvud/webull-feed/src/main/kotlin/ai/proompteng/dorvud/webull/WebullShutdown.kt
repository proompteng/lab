package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WebullCapture
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel

internal suspend fun drainWebullPublisher(
  ingress: Job,
  queue: Channel<WebullCapture>,
  publisher: Job,
) {
  val inputs = ingress.children.toList()
  inputs.forEach { it.cancel() }
  inputs.forEach { it.join() }
  queue.close()
  publisher.join()
}
