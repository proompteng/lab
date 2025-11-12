package ai.proompteng.graf

import ai.proompteng.graf.autoresearch.AutoResearchLauncher
import ai.proompteng.graf.autoresearch.AutoResearchService
import ai.proompteng.graf.codex.ArgoWorkflowClient
import ai.proompteng.graf.codex.CodexResearchActivitiesImpl
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.codex.CodexResearchWorkflowImpl
import ai.proompteng.graf.codex.MinioArtifactFetcherImpl
import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.config.MinioEndpointTarget
import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.config.TemporalConfig
import ai.proompteng.graf.config.resolveMinioEndpoint
import ai.proompteng.graf.neo4j.Neo4jClient
import ai.proompteng.graf.services.GraphService
import ai.proompteng.graf.telemetry.GrafTelemetry
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.minio.BucketExistsArgs
import io.minio.MinioClient
import io.quarkus.runtime.Startup
import io.quarkus.runtime.StartupEvent
import io.temporal.api.workflowservice.v1.GetSystemInfoRequest
import io.temporal.authorization.AuthorizationGrpcMetadataProvider
import io.temporal.authorization.AuthorizationTokenSupplier
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowClientOptions
import io.temporal.common.converter.DefaultDataConverter
import io.temporal.common.converter.JacksonJsonPayloadConverter
import io.temporal.serviceclient.WorkflowServiceStubs
import io.temporal.serviceclient.WorkflowServiceStubsOptions
import io.temporal.worker.WorkerFactory
import jakarta.annotation.PostConstruct
import jakarta.annotation.PreDestroy
import jakarta.enterprise.event.Observes
import jakarta.enterprise.inject.Produces
import jakarta.inject.Singleton
import kotlinx.serialization.json.Json
import mu.KotlinLogging
import org.neo4j.driver.AuthTokens
import org.neo4j.driver.GraphDatabase
import java.io.FileInputStream
import java.net.URI
import java.net.http.HttpClient
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory

@Singleton
@Startup
class GrafConfiguration {
  private val logger = KotlinLogging.logger {}
  private val neo4jConfig = Neo4jConfig.fromEnvironment()
  private val neo4jDriver =
    GraphDatabase.driver(
      neo4jConfig.uri,
      AuthTokens.basic(neo4jConfig.username, neo4jConfig.password),
      neo4jConfig.toDriverConfig(),
    )
  private val neo4jClient = Neo4jClient(neo4jDriver, neo4jConfig.database)
  private val graphService = GraphService(neo4jClient)

  private val temporalConfig = TemporalConfig.fromEnvironment()
  private val argoConfig = ArgoConfig.fromEnvironment()
  private val minioConfig = MinioConfig.fromEnvironment()

  private val minioClient = buildMinioClient(minioConfig)
  private val artifactFetcher = MinioArtifactFetcherImpl(minioClient)
  private val sharedJson =
    Json {
      encodeDefaults = true
      prettyPrint = false
      explicitNulls = false
      ignoreUnknownKeys = true
    }

  private val kubernetesToken = loadServiceAccountToken(argoConfig.tokenPath)
  private val kubernetesHttpClient = buildKubernetesHttpClient(argoConfig)
  private val argoClient =
    ArgoWorkflowClient(argoConfig, kubernetesHttpClient, minioConfig, sharedJson, kubernetesToken)
  private val codexActivities = CodexResearchActivitiesImpl(argoClient, graphService, artifactFetcher, sharedJson)

  private val temporalObjectMapper =
    jacksonObjectMapper()
      .findAndRegisterModules()
      .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
  private val temporalDataConverter =
    DefaultDataConverter
      .newDefaultInstance()
      .withPayloadConverterOverrides(JacksonJsonPayloadConverter(temporalObjectMapper))

  private val serviceStubs = buildServiceStubs(temporalConfig)
  private val workflowClient =
    WorkflowClient.newInstance(
      serviceStubs,
      WorkflowClientOptions
        .newBuilder()
        .setNamespace(temporalConfig.namespace)
        .setIdentity(temporalConfig.identity)
        .setDataConverter(temporalDataConverter)
        .setContextPropagators(listOf(GrafTelemetry.openTelemetryContextPropagator()))
        .build(),
    )
  private val codexResearchService =
    CodexResearchService(workflowClient, temporalConfig.taskQueue, argoConfig.pollTimeoutSeconds)
  private val autoResearchService = AutoResearchService(codexResearchService)

  private val workerFactory = WorkerFactory.newInstance(workflowClient)
  private val worker = workerFactory.newWorker(temporalConfig.taskQueue)

  @Suppress("unused")
  fun onStart(@Observes event: StartupEvent) {
    warmTemporalConnection()
    warmNeo4jConnectivity()
    warmMinioClient()
  }

  @PostConstruct
  fun startWorker() {
    worker.registerWorkflowImplementationTypes(CodexResearchWorkflowImpl::class.java)
    worker.registerActivitiesImplementations(codexActivities)
    workerFactory.start()
  }

  @Produces
  fun graphService(): GraphService = graphService

  @Produces
  fun codexResearchService(): CodexResearchService = codexResearchService

  @Produces
  fun autoResearchLauncher(): AutoResearchLauncher = autoResearchService

  @Produces
  fun minioConfig(): MinioConfig = minioConfig

  @PreDestroy
  fun shutdown() {
    workerFactory.shutdown()
    serviceStubs.shutdown()
    minioClient.close()
    if (!neo4jClient.isClosed) {
      neo4jClient.close()
    }
    GrafTelemetry.shutdown()
  }

  private fun buildServiceStubs(config: TemporalConfig): WorkflowServiceStubs {
    val builder = WorkflowServiceStubsOptions.newBuilder().setTarget(config.address)
    config.authToken?.takeIf(String::isNotBlank)?.let { token ->
      val bearerToken = if (token.startsWith("Bearer ", ignoreCase = true)) token else "Bearer $token"
      builder.addGrpcMetadataProvider(
        AuthorizationGrpcMetadataProvider(AuthorizationTokenSupplier { bearerToken }),
      )
    }
    return WorkflowServiceStubs.newServiceStubs(builder.build())
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

private fun buildKubernetesHttpClient(config: ArgoConfig): HttpClient {
  val trustManager = loadTrustManager(config.caCertPath)
  val sslContext =
    SSLContext.getInstance("TLS").apply {
      init(null, arrayOf(trustManager), null)
    }
  return HttpClient
    .newBuilder()
    .sslContext(sslContext)
    .build()
}

private fun buildMinioClient(config: MinioConfig): MinioClient {
  val builder =
    MinioClient
      .builder()
      .credentials(config.accessKey, config.secretKey)

  when (val target = resolveMinioEndpoint(config)) {
    is MinioEndpointTarget.Url -> builder.endpoint(target.value)
    is MinioEndpointTarget.HostPort -> builder.endpoint(target.host, target.port, target.secure)
  }
  config.region?.let { builder.region(it) }
  return builder.build()
}

private fun loadServiceAccountToken(path: String): String = FileInputStream(path).use { it.bufferedReader().readText().trim() }

private fun loadTrustManager(caPath: String): TrustManager =
  FileInputStream(caPath).use { caStream ->
    val certificateFactory = CertificateFactory.getInstance("X.509")
    val certificate = certificateFactory.generateCertificate(caStream)
    val keyStore =
      KeyStore.getInstance(KeyStore.getDefaultType()).apply {
        load(null, null)
        setCertificateEntry("k8s-ca", certificate)
      }
    val factory =
      TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
        init(keyStore)
      }
    factory.trustManagers.firstOrNull() ?: throw IllegalStateException("No trust manager available")
  }
