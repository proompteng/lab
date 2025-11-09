package ai.proompteng.graf.codex

import ai.proompteng.graf.model.ArtifactReference
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.minio.GetObjectResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class MinioArtifactFetcherTest {
  @Test
  fun `open rejects missing bucket`() {
    val client = mockk<io.minio.MinioClient>()
    val fetcher = MinioArtifactFetcherImpl(client)
    val reference = ArtifactReference("", "key", "https://minio", null)

    assertFailsWith<IllegalArgumentException> {
      fetcher.open(reference)
    }
  }

  @Test
  fun `open rejects missing key`() {
    val client = mockk<io.minio.MinioClient>()
    val fetcher = MinioArtifactFetcherImpl(client)
    val reference = ArtifactReference("bucket", "", "https://minio", null)

    assertFailsWith<IllegalArgumentException> {
      fetcher.open(reference)
    }
  }

  @Test
  fun `open forwards call to Minio client`() {
    val client = mockk<io.minio.MinioClient>()
    val fetcher = MinioArtifactFetcherImpl(client)
    val reference = ArtifactReference("bucket", "key", "https://minio", "us")
    val slot = slot<io.minio.GetObjectArgs>()
    val stream = mockk<GetObjectResponse>(relaxed = true)
    every { client.getObject(capture(slot)) } returns stream

    val result = fetcher.open(reference)

    assertEquals(stream, result)
    assertEquals("bucket", slot.captured.bucket())
    assertEquals("key", slot.captured.`object`())
  }
}
