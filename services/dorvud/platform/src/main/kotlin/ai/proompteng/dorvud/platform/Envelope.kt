package ai.proompteng.dorvud.platform

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import java.time.Instant

/** Shared envelope used for all forwarder outputs. */
@Serializable
data class Envelope<T>(
  @Serializable(with = InstantIsoSerializer::class)
  val ingestTs: Instant,
  @Serializable(with = InstantIsoSerializer::class)
  val eventTs: Instant,
  val feed: String,
  val channel: String,
  val symbol: String,
  val seq: Long,
  val payload: T,
  val accountLabel: String? = null,
  val isFinal: Boolean = true,
  val source: String = "ws",
  val window: Window? = null,
  val version: Int = 1,
)

@Serializable
data class Window(
  val size: String,
  val step: String,
  val start: String,
  val end: String,
)

/** Simple ISO-8601 serializer for java.time.Instant. */
object InstantIsoSerializer : KSerializer<Instant> {
  override val descriptor: SerialDescriptor =
    PrimitiveSerialDescriptor("Instant", PrimitiveKind.STRING)

  override fun serialize(
    encoder: Encoder,
    value: Instant,
  ) {
    encoder.encodeString(value.toString())
  }

  override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
}
