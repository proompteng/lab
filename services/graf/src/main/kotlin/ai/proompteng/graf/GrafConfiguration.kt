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
import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.config.TemporalConfig
import ai.proompteng.graf.neo4j.Neo4jClient
import ai.proompteng.graf.services.GraphService
import ai.proompteng.graf.telemetry.GrafTelemetry
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.minio.MinioClient
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
import jakarta.enterprise.inject.Produces
import jakarta.inject.Singleton
import kotlinx.serialization.json.Json
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
class GrafConfiguration {
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
  val (host, port) = parseMinioEndpoint(config.endpoint, config.secure)
  val builder =
    MinioClient
      .builder()
      .endpoint(host, port, config.secure)
      .credentials(config.accessKey, config.secretKey)
  config.region?.let { builder.region(it) }
  return builder.build()
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
