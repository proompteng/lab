package ai.proompteng.dorvud.webull

import ai.proompteng.dorvud.platform.WebullCapture
import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.webullCapture
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.MqttCallback
import org.eclipse.paho.client.mqttv3.MqttClient
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import java.net.URI
import java.util.UUID

class WebullMqtt(
  private val credentials: WebullCredentials,
  val sessionId: String = UUID.randomUUID().toString(),
  broker: String = "ssl://data-api.webull.com:1883",
  private val receive: (WebullCapture) -> Unit,
  private val heartbeat: () -> Unit = {},
) {
  private val client = MqttClient(broker, sessionId, MemoryPersistence())
  val disconnected = CompletableDeferred<Throwable?>()

  @Volatile var undelivered: WebullCapture? = null
    private set

  init {
    val uri = URI(broker)
    require(broker == "ssl://data-api.webull.com:1883" || uri.host in setOf("127.0.0.1", "localhost")) {
      "Webull MQTT broker must be production or local test server"
    }
    client.setCallback(
      object : MqttCallback {
        override fun connectionLost(cause: Throwable?) {
          disconnected.complete(cause)
        }

        override fun deliveryComplete(token: IMqttDeliveryToken?) = Unit

        override fun messageArrived(
          topic: String,
          message: MqttMessage,
        ) {
          try {
            if (topic == "echo") {
              heartbeat()
            } else {
              val capture = webullCapture(WebullSource.Mqtt(sessionId, topic), message.payload)
              undelivered = capture
              receive(capture)
              undelivered = null
            }
          } catch (failure: Exception) {
            disconnected.complete(failure)
            throw failure
          }
        }
      },
    )
  }

  suspend fun connect() =
    runInterruptible(Dispatchers.IO) {
      client.connect(
        MqttConnectOptions().apply {
          userName = credentials.appKey
          password = UUID.randomUUID().toString().toCharArray()
          isCleanSession = true
          isAutomaticReconnect = false
          isHttpsHostnameVerificationEnabled = true
          connectionTimeout = 10
          keepAliveInterval = 30
        },
      )
    }

  suspend fun close() =
    runInterruptible(Dispatchers.IO) {
      try {
        if (client.isConnected) client.disconnect(2_000)
      } finally {
        client.close(true)
      }
    }
}
