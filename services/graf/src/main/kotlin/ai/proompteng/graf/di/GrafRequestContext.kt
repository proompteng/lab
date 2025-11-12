package ai.proompteng.graf.di

import jakarta.enterprise.context.RequestScoped
import java.util.UUID

@RequestScoped
class GrafRequestContext {
  var requestId: String = UUID.randomUUID().toString()
  var bearerPrincipal: String? = null
  var traceId: String? = null
  var spanId: String? = null
}
