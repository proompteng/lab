package ai.proompteng.graf.runtime

import java.util.UUID

class GrafRequestContext {
  var requestId: String = UUID.randomUUID().toString()
  var bearerPrincipal: String? = null
  var traceId: String? = null
  var spanId: String? = null
}
