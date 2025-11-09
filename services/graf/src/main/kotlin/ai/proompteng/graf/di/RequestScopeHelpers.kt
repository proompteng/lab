package ai.proompteng.graf.di

import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.util.AttributeKey
import org.koin.core.Koin
import org.koin.core.qualifier.named
import org.koin.core.scope.Scope
import java.util.UUID

internal val requestQualifier = named("graf-request-scope")
internal val requestScopeAttributeKey = AttributeKey<Scope>("graf-request-scope")

internal fun ApplicationCall.requestScope(): Scope = attributes[requestScopeAttributeKey]

internal fun Application.createRequestScopeForCall(
  call: ApplicationCall,
  koin: Koin,
): Scope {
  val scope = koin.createScope(UUID.randomUUID().toString(), requestQualifier)
  call.attributes.put(requestScopeAttributeKey, scope)
  return scope
}
