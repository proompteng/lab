package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WebullCapture
import ai.proompteng.dorvud.platform.inspectWebullCapture
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.net.ServerSocket
import java.util.Base64
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals

class WebullMqttTest {
  @Test
  fun `real MQTT client preserves native protobuf bytes and observes broker disconnect`() =
    runBlocking {
      val body =
        Base64.getDecoder().decode(
          "CisKBEFBUEwSD3Rlc3QtaW5zdHJ1bWVudBoNMTc5MzQwNDgwMDE2MSIDUlRIEiMKFDEuMTIzNDU2Nzg5MTIzNDU2Nzg5EgswLjAwMDAwMDAwMRoGCgEwEgEw",
        )
      val received = CompletableDeferred<WebullCapture>()
      ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { server ->
        val broker =
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
          client.close()
          broker.join(2_000)
        }
      }
    }
}
