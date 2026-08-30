package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import ai.proompteng.graf.telemetry.GrafTelemetry
import io.minio.GetObjectArgs
import io.minio.MinioClient
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import kotlinx.coroutines.runBlocking
import java.io.InputStream

interface MinioArtifactFetcher {
  fun open(reference: ArtifactReference): InputStream
}

class MinioArtifactFetcherImpl(
  private val client: MinioClient,
) : MinioArtifactFetcher {
  override fun open(reference: ArtifactReference): InputStream =
    runBlocking {
      val args =
        GetObjectArgs
          .builder()
          .bucket(reference.bucket)
          .`object`(reference.key)
          .build()
      GrafTelemetry.withSpan(
        "graf.minio.fetch",
        Attributes
          .builder()
          .put(AttributeKey.stringKey("artifact.bucket"), reference.bucket)
          .put(AttributeKey.stringKey("artifact.key"), reference.key)
          .build(),
      ) {
        val start = System.nanoTime()
        val stream = client.getObject(args)
        val durationMs = (System.nanoTime() - start) / 1_000_000
        GrafTelemetry.recordArtifactFetch(durationMs, reference.key, reference.bucket)
        stream
      }
    }
}
