package ai.proompteng.graf.config

import java.lang.IllegalStateException
import java.net.URI

data class MinioConfig(
  val endpoint: String,
  val bucket: String,
  val accessKey: String,
  val secretKey: String,
  val secure: Boolean,
  val region: String?,
) {
  val artifactEndpoint: String = sanitizeEndpointForArtifacts(endpoint, secure)

  companion object {
    private const val DEFAULT_AGENTS_ARTIFACTS_BUCKET = "agents-artifacts"

    fun fromEnvironment(env: Map<String, String> = System.getenv()): MinioConfig {
      val endpoint =
        env["AGENTS_ARTIFACTS_ENDPOINT"]?.takeIf { it.isNotBlank() }
          ?: throw IllegalStateException("AGENTS_ARTIFACTS_ENDPOINT must be set")
      val bucket =
        env["AGENTS_ARTIFACTS_BUCKET"]?.takeIf { it.isNotBlank() }
          ?: DEFAULT_AGENTS_ARTIFACTS_BUCKET
      val accessKey =
        env["AGENTS_ARTIFACTS_ACCESS_KEY_ID"]?.takeIf { it.isNotBlank() }
          ?: throw IllegalStateException("AGENTS_ARTIFACTS_ACCESS_KEY_ID must be set")
      val secretKey =
        env["AGENTS_ARTIFACTS_SECRET_ACCESS_KEY"]?.takeIf { it.isNotBlank() }
          ?: throw IllegalStateException("AGENTS_ARTIFACTS_SECRET_ACCESS_KEY must be set")
      val secure =
        env["AGENTS_ARTIFACTS_SECURE"]?.equals("true", ignoreCase = true)
          ?: true
      val region =
        env["AGENTS_ARTIFACTS_REGION"]?.takeIf { it.isNotBlank() }
      return MinioConfig(endpoint, bucket, accessKey, secretKey, secure, region)
    }

    private fun sanitizeEndpointForArtifacts(
      endpoint: String,
      defaultSecure: Boolean,
    ): String {
      val normalized =
        if (endpoint.contains("://")) {
          endpoint
        } else {
          "${if (defaultSecure) "https" else "http"}://$endpoint"
        }
      val uri = URI.create(normalized)
      val host = uri.host ?: throw IllegalArgumentException("AGENTS_ARTIFACTS_ENDPOINT must include a host")
      val port =
        when {
          uri.port != -1 -> uri.port
          uri.scheme.equals("https", ignoreCase = true) -> 443
          defaultSecure -> 443
          else -> 80
        }
      return "$host:$port"
    }
  }
}
