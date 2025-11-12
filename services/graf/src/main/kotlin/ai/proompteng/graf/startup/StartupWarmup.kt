package ai.proompteng.graf.startup

import ai.proompteng.graf.config.MinioConfig
import io.minio.BucketExistsArgs
import io.minio.MinioClient
import io.temporal.api.workflowservice.v1.GetSystemInfoRequest
import io.temporal.serviceclient.WorkflowServiceStubs
import mu.KLogger
import org.neo4j.driver.Driver

class StartupWarmup(
  private val serviceStubs: WorkflowServiceStubs,
  private val neo4jDriver: Driver,
  private val minioClient: MinioClient,
  private val minioConfig: MinioConfig,
  private val logger: KLogger,
) {
  fun run() {
    warmTemporalConnection()
    warmNeo4jConnectivity()
    warmMinioClient()
  }

  private fun warmTemporalConnection() {
    runCatching {
      serviceStubs
        .blockingStub()
        .getSystemInfo(GetSystemInfoRequest.getDefaultInstance())
      logger.info { "Temporal connection warm-up completed" }
    }.onFailure { error ->
      logger.warn(error) { "Temporal warm-up ping failed; workflow start latency may spike on first request" }
    }
  }

  private fun warmNeo4jConnectivity() {
    runCatching {
      neo4jDriver.verifyConnectivity()
      logger.info { "Neo4j connectivity verified during startup" }
    }.onFailure { error ->
      logger.warn(error) { "Neo4j warm-up failed; first request may incur driver initialization" }
    }
  }

  private fun warmMinioClient() {
    runCatching {
      val args = BucketExistsArgs.builder().bucket(minioConfig.bucket).build()
      minioClient.bucketExists(args)
      logger.info { "MinIO client warmed by checking bucket ${minioConfig.bucket}" }
    }.onFailure { error ->
      logger.warn(error) { "MinIO warm-up failed; first artifact download may be slower" }
    }
  }
}
