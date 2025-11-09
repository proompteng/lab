package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import io.minio.GetObjectArgs
import io.minio.MinioClient
import java.io.InputStream

interface MinioArtifactFetcher {
  fun open(reference: ArtifactReference): InputStream
}

class MinioArtifactFetcherImpl(
  private val client: MinioClient,
) : MinioArtifactFetcher {
  override fun open(reference: ArtifactReference): InputStream {
    require(reference.bucket.isNotBlank()) { "artifact bucket must be provided" }
    require(reference.key.isNotBlank()) { "artifact key must be provided" }
    val args =
      GetObjectArgs
        .builder()
        .bucket(reference.bucket)
        .`object`(reference.key)
        .build()
    return client.getObject(args)
  }
}
