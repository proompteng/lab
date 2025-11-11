package ai.proompteng.graf.config

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MinioEndpointResolverTest {
  private fun config(
    endpoint: String,
    secure: Boolean = true,
  ) = MinioConfig(
    endpoint = endpoint,
    bucket = "bucket",
    accessKey = "access",
    secretKey = "secret",
    secure = secure,
    region = null,
  )

  @Test
  fun `returns url target when endpoint includes scheme`() {
    val target = resolveMinioEndpoint(config("http://observability-minio:9000", secure = false))

    assertTrue(target is MinioEndpointTarget.Url)
    assertEquals("http://observability-minio:9000", target.value)
  }

  @Test
  fun `returns host and port when endpoint omits scheme`() {
    val target = resolveMinioEndpoint(config("observability-minio:9000", secure = false))

    require(target is MinioEndpointTarget.HostPort)
    assertEquals("observability-minio", target.host)
    assertEquals(9000, target.port)
    assertEquals(false, target.secure)
  }

  @Test
  fun `defaults to https port when secure`() {
    val target = resolveMinioEndpoint(config("observability-minio", secure = true))

    require(target is MinioEndpointTarget.HostPort)
    assertEquals(443, target.port)
    assertEquals(true, target.secure)
  }
}
