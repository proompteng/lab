package ai.proompteng.graf.model

import kotlinx.serialization.Serializable

@Serializable
data class ErrorResponse(
  val error: String,
)

@Serializable
data class ServiceStatusResponse(
  val service: String,
  val status: String,
  val version: String? = null,
  val commit: String? = null,
)

@Serializable
data class HealthzResponse(
  val status: String,
  val port: String? = null,
)
