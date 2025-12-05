package ai.proompteng.dorvud.ws

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Polymorphic dispatch on Alpaca market data field `T`. */
object AlpacaMessageSerializer : KSerializer<AlpacaMessage> {
  override val descriptor: SerialDescriptor = buildClassSerialDescriptor("AlpacaMessage")

  override fun serialize(encoder: Encoder, value: AlpacaMessage) {
    throw SerializationException("encoding not supported")
  }

  override fun deserialize(decoder: Decoder): AlpacaMessage {
    val input = decoder as? JsonDecoder ?: error("JSON decoder required")
    val element = input.decodeJsonElement()
    val type = element.jsonObject["T"]?.jsonPrimitive?.content
      ?: throw SerializationException("missing T field")
    return when (type) {
      "t" -> input.json.decodeFromJsonElement(AlpacaTrade.serializer(), element)
      "q" -> input.json.decodeFromJsonElement(AlpacaQuote.serializer(), element)
      "b" -> input.json.decodeFromJsonElement(AlpacaBar.serializer(), element)
      "u" -> input.json.decodeFromJsonElement(AlpacaUpdatedBar.serializer(), element)
      "s" -> input.json.decodeFromJsonElement(AlpacaStatus.serializer(), element)
      "subscription" -> input.json.decodeFromJsonElement(AlpacaSubscription.serializer(), element)
      "success" -> input.json.decodeFromJsonElement(AlpacaSuccess.serializer(), element)
      else -> throw SerializationException("unknown message type: $type")
    }
  }
}
