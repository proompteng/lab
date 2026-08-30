package ai.proompteng.dorvud.ws

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Polymorphic dispatch on Alpaca market data field `T`. */
object AlpacaMessageSerializer : KSerializer<AlpacaMessage> {
  override val descriptor: SerialDescriptor = buildClassSerialDescriptor("AlpacaMessage")

  override fun serialize(
    encoder: Encoder,
    value: AlpacaMessage,
  ): Unit = throw SerializationException("encoding not supported")

  override fun deserialize(decoder: Decoder): AlpacaMessage {
    val input = decoder as? JsonDecoder ?: error("JSON decoder required")
    val element = input.decodeJsonElement()
    val obj = element as? JsonObject ?: return AlpacaUnknownMessage("non_object", element)
    val type =
      obj["T"]?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }
        ?: return AlpacaUnknownMessage("missing_T", obj)
    return when (type) {
      "t" -> input.json.decodeFromJsonElement(AlpacaTrade.serializer(), normalizeConditions(obj))
      "q" -> input.json.decodeFromJsonElement(AlpacaQuote.serializer(), normalizeConditions(obj))
      "b" -> input.json.decodeFromJsonElement(AlpacaBar.serializer(), obj)
      "u" -> input.json.decodeFromJsonElement(AlpacaUpdatedBar.serializer(), obj)
      "s" -> input.json.decodeFromJsonElement(AlpacaStatus.serializer(), obj)
      "subscription" -> input.json.decodeFromJsonElement(AlpacaSubscription.serializer(), obj)
      "success" -> input.json.decodeFromJsonElement(AlpacaSuccess.serializer(), obj)
      "error" -> input.json.decodeFromJsonElement(AlpacaError.serializer(), obj)
      else -> AlpacaUnknownMessage(type, obj)
    }
  }

  private fun normalizeConditions(obj: JsonObject): JsonObject {
    val condition = obj["c"] ?: return obj
    if (condition is JsonArray) return obj
    val scalar = runCatching { condition.jsonPrimitive.contentOrNull }.getOrNull() ?: return obj
    return JsonObject(obj + ("c" to buildJsonArray { add(JsonPrimitive(scalar)) }))
  }
}
