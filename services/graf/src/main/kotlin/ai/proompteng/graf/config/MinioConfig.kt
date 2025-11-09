package ai.proompteng.graf.config

import java.lang.IllegalStateException

data class MinioConfig(
  val endpoint: String,
  val bucket: String,
  val accessKey: String,
  val secretKey: String,
  val secure: Boolean,
  val region: String?,
) {
  companion object {
    fun fromEnvironment(): MinioConfig {
      val env = System.getenv()
      val endpoint =
        env["MINIO_ENDPOINT"]?.takeIf { it.isNotBlank() }
          ?: throw IllegalStateException("MINIO_ENDPOINT must be set")
      val bucket =
        env["MINIO_BUCKET"]?.takeIf { it.isNotBlank() }
          ?: throw IllegalStateException("MINIO_BUCKET must be set")
      val accessKey =
        env["MINIO_ACCESS_KEY"]?.takeIf { it.isNotBlank() }
          ?: throw IllegalStateException("MINIO_ACCESS_KEY must be set")
      val secretKey =
        env["MINIO_SECRET_KEY"]?.takeIf { it.isNotBlank() }
          ?: throw IllegalStateException("MINIO_SECRET_KEY must be set")
      val secure = env["MINIO_SECURE"]?.equals("true", ignoreCase = true) ?: true
      val region = env["MINIO_REGION"]?.takeIf { it.isNotBlank() }
      return MinioConfig(endpoint, bucket, accessKey, secretKey, secure, region)
    }
  }
}
