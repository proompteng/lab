package ai.proompteng.graf.telemetry

import io.ktor.server.application.ApplicationCall
import io.ktor.util.AttributeKey

internal val routeTemplateAttribute = AttributeKey<String>("graf.route.template")

fun ApplicationCall.setRouteTemplate(template: String) {
  attributes.put(routeTemplateAttribute, template)
}

fun ApplicationCall.currentRouteTemplate(): String? = attributes.getOrNull(routeTemplateAttribute)
