package ai.proompteng.graf.config

import java.net.URI

internal sealed interface MinioEndpointTarget {
  data class Url(
    val value: String,
  ) : MinioEndpointTarget

  data class HostPort(
    val host: String,
    val port: Int,
    val secure: Boolean,
  ) : MinioEndpointTarget
}

internal fun resolveMinioEndpoint(config: MinioConfig): MinioEndpointTarget {
  val endpoint = config.endpoint.trim()
  return if (endpoint.contains("://")) {
    MinioEndpointTarget.Url(endpoint)
  } else {
    val (host, port) = parseMinioEndpoint(endpoint, config.secure)
    MinioEndpointTarget.HostPort(host, port, config.secure)
  }
}

private fun parseMinioEndpoint(
  endpoint: String,
  defaultSecure: Boolean,
): Pair<String, Int> {
  val normalized =
    if (endpoint.contains("://")) {
      endpoint
    } else {
      "${if (defaultSecure) "https" else "http"}://$endpoint"
    }
  val uri = URI.create(normalized)
  val host = uri.host ?: throw IllegalArgumentException("MINIO_ENDPOINT must include a host")
  val port =
    when {
      uri.port != -1 -> uri.port
      uri.scheme.equals("https", ignoreCase = true) -> 443
      defaultSecure -> 443
      else -> 80
    }
  return host to port
}
