package ai.proompteng.graf.security

import ai.proompteng.graf.di.requestScope
import io.ktor.server.application.ApplicationCall
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.request.header
import java.util.UUID

/** Captures the metadata we want to thread through request-scoped workers. */
data class AuditContext(
  val requestId: String,
  val principal: String?,
  val authorizationHeader: String?,
) {
  companion object {
    internal fun from(call: ApplicationCall): AuditContext {
      val requestId = call.request.headers["X-Request-ID"]?.takeIf(String::isNotBlank) ?: UUID.randomUUID().toString()
      val principal = call.principal<UserIdPrincipal>()?.name
      val authorization = call.request.headers["Authorization"]?.takeIf(String::isNotBlank)
      return AuditContext(requestId = requestId, principal = principal, authorizationHeader = authorization)
    }
  }
}

/** Returns the request-scoped audit context populated by the Koin request scope. */
fun ApplicationCall.auditContext(): AuditContext = requestScope().get()
