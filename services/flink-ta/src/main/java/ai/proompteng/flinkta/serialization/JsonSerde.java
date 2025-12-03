package ai.proompteng.flinkta.serialization;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import org.apache.flink.api.common.serialization.DeserializationSchema;
import org.apache.flink.api.common.serialization.SerializationSchema;
import org.apache.flink.api.common.typeinfo.TypeInformation;

public final class JsonSerde {
  private static final ObjectMapper MAPPER = new ObjectMapper()
      .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

  private JsonSerde() {}

  public static <T> DeserializationSchema<T> deserializer(Class<T> type) {
    return new DeserializationSchema<>() {
      @Override
      public T deserialize(byte[] message) throws IOException {
        return MAPPER.readValue(message, type);
      }

      @Override
      public boolean isEndOfStream(T nextElement) {
        return false;
      }

      @Override
      public TypeInformation<T> getProducedType() {
        return TypeInformation.of(type);
      }
    };
  }

  public static <T> SerializationSchema<T> serializer() {
    return new SerializationSchema<>() {
      @Override
      public byte[] serialize(T element) {
        try {
          return MAPPER.writeValueAsBytes(element);
        } catch (IOException e) {
          throw new RuntimeException("Unable to serialize message", e);
        }
      }
    };
  }
}
