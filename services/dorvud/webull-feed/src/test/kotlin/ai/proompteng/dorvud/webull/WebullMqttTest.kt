package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WebullCapture
import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.inspectWebullCapture
import ai.proompteng.dorvud.platform.webullCapture
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.net.ServerSocket
import java.util.Base64
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class WebullMqttTest {
  private val body =
    Base64.getDecoder().decode(
      "CisKBEFBUEwSD3Rlc3QtaW5zdHJ1bWVudBoNMTc5MzQwNDgwMDE2MSIDUlRIEiMKFDEuMTIzNDU2Nzg5MTIzNDU2Nzg5EgswLjAwMDAwMDAwMRoGCgEwEgEw",
    )

  private fun serveQuote(server: ServerSocket) =
    thread {
      server.accept().use { socket ->
        val input = socket.getInputStream()
        require(input.read() == 0x10)
        var remaining = 0
        var multiplier = 1
        do {
          val digit = input.read()
          require(digit >= 0)
          remaining += (digit and 127) * multiplier
          multiplier *= 128
        } while (digit and 128 != 0)
        require(input.readNBytes(remaining).size == remaining)
        val output = socket.getOutputStream()
        output.write(byteArrayOf(0x20, 2, 0, 0))
        output.flush()
        Thread.sleep(50)
        val topic = "quote".toByteArray()
        val size = 2 + topic.size + body.size
        require(size < 128)
        output.write(byteArrayOf(0x30, size.toByte(), 0, topic.size.toByte()))
        output.write(topic)
        output.write(body)
        output.flush()
        Thread.sleep(200)
      }
    }

  @Test
  fun `real MQTT client preserves native protobuf bytes and observes broker disconnect`() =
    runBlocking {
      val received = CompletableDeferred<WebullCapture>()
      ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { server ->
        val broker = serveQuote(server)
        val client =
          WebullMqtt(WebullCredentials("test-app", "test-secret"), broker = "tcp://127.0.0.1:${server.localPort}", receive = {
            received.complete(it)
          })
        try {
          client.connect()
          val capture = withTimeout(5_000) { received.await() }
          assertEquals(body.toList(), capture.bytes().toList())
          assertEquals("AAPL", inspectWebullCapture(capture).observations.single().symbol)
          withTimeout(5_000) { client.disconnected.await() }
        } finally {
          client.close {}
          broker.join(2_000)
        }
      }
    }

  @Test
  fun `retained MQTT capture survives backpressure longer than the old cleanup deadline`() =
    runBlocking {
      ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { server ->
        val broker = serveQuote(server)
        val received = CompletableDeferred<Unit>()
        val queue = Channel<WebullCapture>(1)
        queue.send(webullCapture(WebullSource.Collector("coverage"), "{}".toByteArray()))
        val client =
          WebullMqtt(WebullCredentials("test-app", "test-secret"), broker = "tcp://127.0.0.1:${server.localPort}", receive = {
            received.complete(Unit)
            error("simulated publisher backpressure")
          })
        client.connect()
        withTimeout(5_000) {
          received.await()
          client.disconnected.await()
        }
        val closing = async { client.close { queue.send(it) } }
        try {
          delay(5_250)
          assertFalse(closing.isCompleted)
          queue.receive()
          withTimeout(5_000) { closing.await() }
          assertEquals(body.toList(), queue.receive().bytes().toList())
        } finally {
          closing.cancelAndJoin()
          queue.close()
          runCatching { client.close {} }
          broker.join(2_000)
        }
      }
    }
}
