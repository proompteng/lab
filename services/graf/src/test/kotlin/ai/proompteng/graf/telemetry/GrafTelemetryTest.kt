package ai.proompteng.graf.telemetry

import java.util.function.Supplier
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class GrafTelemetryTest {
  @Test
  fun `header supplier is always initialized`() {
    val instanceField = GrafTelemetry::class.java.getDeclaredField("INSTANCE")
    instanceField.isAccessible = true
    val instance = instanceField.get(null)

    val headerField = GrafTelemetry::class.java.getDeclaredField("headerSupplier")
    headerField.isAccessible = true
    val supplier = headerField.get(instance) as Supplier<*>

    val headers = supplier.get()
    assertNotNull(headers)
    assertTrue(headers is Map<*, *>)
  }
}
