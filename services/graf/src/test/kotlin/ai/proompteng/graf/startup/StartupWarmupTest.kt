package ai.proompteng.graf.startup

import ai.proompteng.graf.config.MinioConfig
import io.minio.BucketExistsArgs
import io.minio.MinioClient
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import io.temporal.api.workflowservice.v1.GetSystemInfoRequest
import io.temporal.api.workflowservice.v1.WorkflowServiceGrpc
import io.temporal.serviceclient.WorkflowServiceStubs
import mu.KLogger
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow
import org.neo4j.driver.Driver

class StartupWarmupTest {
  private val blockingStub = mockk<WorkflowServiceGrpc.WorkflowServiceBlockingStub>(relaxed = true)
  private val serviceStubs = mockk<WorkflowServiceStubs>()
  private val neo4jDriver = mockk<Driver>(relaxed = true)
  private val minioClient = mockk<MinioClient>(relaxed = true)
  private val minioConfig =
    MinioConfig(
      endpoint = "http://localhost:9000",
      bucket = "argo-workflows",
      accessKey = "key",
      secretKey = "secret",
      secure = false,
      region = null,
    )
  private val logger = mockk<KLogger>(relaxed = true)

  init {
    every { serviceStubs.blockingStub() } returns blockingStub
    every { blockingStub.withDeadlineAfter(any(), any()) } returns blockingStub
  }

  @Test
  fun `run warms all dependencies`() {
    every { blockingStub.getSystemInfo(any<GetSystemInfoRequest>()) } returns mockk(relaxed = true)
    every { minioClient.bucketExists(any<BucketExistsArgs>()) } returns true

    val warmup = StartupWarmup(serviceStubs, neo4jDriver, minioClient, minioConfig, logger)

    warmup.run()

    verify(exactly = 1) { blockingStub.withDeadlineAfter(any(), any()) }
    verify(exactly = 1) { blockingStub.getSystemInfo(any<GetSystemInfoRequest>()) }
    verify(exactly = 1) { neo4jDriver.verifyConnectivity() }
    verify(exactly = 1) { minioClient.bucketExists(any<BucketExistsArgs>()) }
  }

  @Test
  fun `run swallows failures`() {
    every { blockingStub.getSystemInfo(any<GetSystemInfoRequest>()) } throws IllegalStateException("temporal down")

    every { neo4jDriver.verifyConnectivity() } throws IllegalStateException("neo4j down")
    every { minioClient.bucketExists(any<BucketExistsArgs>()) } throws IllegalStateException("minio down")

    val warmup = StartupWarmup(serviceStubs, neo4jDriver, minioClient, minioConfig, logger)

    assertDoesNotThrow { warmup.run() }
  }
}
