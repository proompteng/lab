package ai.proompteng.graf.runtime

import ai.proompteng.graf.autoresearch.AutoResearchLauncher
import ai.proompteng.graf.autoresearch.AutoResearchService
import ai.proompteng.graf.codex.ArgoWorkflowClient
import ai.proompteng.graf.codex.CodexResearchActivities
import ai.proompteng.graf.codex.CodexResearchActivitiesImpl
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.codex.MinioArtifactFetcher
import ai.proompteng.graf.codex.MinioArtifactFetcherImpl
import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.config.MinioEndpointTarget
import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.config.TemporalConfig
import ai.proompteng.graf.config.resolveMinioEndpoint
import ai.proompteng.graf.neo4j.Neo4jClient
import ai.proompteng.graf.services.GraphPersistence
import ai.proompteng.graf.services.GraphService
import ai.proompteng.graf.telemetry.GrafTelemetry
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.koin.core.qualifier.named
import org.koin.dsl.bind
import org.koin.dsl.module
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
import org.neo4j.driver.AuthTokens
import org.neo4j.driver.GraphDatabase
import java.io.FileInputStream
import java.net.http.HttpClient
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory

private const val REQUEST_SCOPE = "graf.request"
private const val QUALIFIER_JSON = "graf.json"
private const val QUALIFIER_ARGO_TOKEN = "graf.argo.token"

object GrafQualifiers {
  val Json = named(QUALIFIER_JSON)
  val ArgoToken = named(QUALIFIER_ARGO_TOKEN)
}

object GrafScopes {
  val Request = named(REQUEST_SCOPE)
}

fun grafLifecycleModule() = module {
  single { GrafLifecycleRegistry() }
}

fun grafConfigModule() = module {
  single { Neo4jConfig.fromEnvironment() }
  single { TemporalConfig.fromEnvironment() }
  single { ArgoConfig.fromEnvironment() }
  single { MinioConfig.fromEnvironment() }
  single(qualifier = GrafQualifiers.Json) { grafJson() }
}

fun grafClientModule() = module {
  single {
    provideNeo4jClient(
      neo4jConfig = get(),
      lifecycle = get(),
    )
  }
  single {
    provideMinioClient(
      config = get(),
      lifecycle = get(),
    )
  }
  single {
    provideWorkflowServiceStubs(
      config = get(),
      lifecycle = get(),
    )
  }
  single {
    provideWorkflowClient(
      config = get(),
      stubs = get(),
    )
  }
  single { WorkerFactory.newInstance(get()) }
  single(qualifier = GrafQualifiers.ArgoToken) { loadServiceAccountToken(get<ArgoConfig>().tokenPath) }
  single { buildKubernetesHttpClient(get()) }
}

fun grafServiceModule() = module {
  single { GraphService(get()) } bind GraphPersistence::class
  single<MinioArtifactFetcher> { MinioArtifactFetcherImpl(get()) }
  single {
    ArgoWorkflowClient(
      config = get(),
      httpClient = get(),
      minioConfig = get(),
      json = get(GrafQualifiers.Json),
      serviceAccountToken = get(GrafQualifiers.ArgoToken),
    )
  }
  single<CodexResearchActivities> {
    CodexResearchActivitiesImpl(
      argoClient = get(),
      graphPersistence = get(),
      artifactFetcher = get(),
      json = get(GrafQualifiers.Json),
    )
  }
  single {
    CodexResearchService(
      workflowClient = get(),
      workflowServiceStubs = get(),
      taskQueue = get<TemporalConfig>().taskQueue,
      argoPollTimeoutSeconds = get<ArgoConfig>().pollTimeoutSeconds,
    )
  }
  single<AutoResearchLauncher> { AutoResearchService(get()) }
}

fun grafRequestScopeModule() = module {
  scope(GrafScopes.Request) {
    scoped { GrafRequestContext() }
  }
}

private fun provideNeo4jClient(
  neo4jConfig: Neo4jConfig,
  lifecycle: GrafLifecycleRegistry,
): Neo4jClient {
  val driver =
    GraphDatabase.driver(
      neo4jConfig.uri,
      AuthTokens.basic(neo4jConfig.username, neo4jConfig.password),
      neo4jConfig.toDriverConfig(),
    )
  val client = Neo4jClient(driver, neo4jConfig.database)
  lifecycle.register { client.close() }
  return client
}

private fun provideMinioClient(
  config: MinioConfig,
  lifecycle: GrafLifecycleRegistry,
): MinioClient {
  val builder =
    MinioClient
      .builder()
      .credentials(config.accessKey, config.secretKey)
  when (val target = resolveMinioEndpoint(config)) {
    is MinioEndpointTarget.Url -> builder.endpoint(target.value)
    is MinioEndpointTarget.HostPort -> builder.endpoint(target.host, target.port, target.secure)
  }
  config.region?.let { builder.region(it) }
  val client = builder.build()
  lifecycle.register { client.close() }
  return client
}

private fun provideWorkflowServiceStubs(
  config: TemporalConfig,
  lifecycle: GrafLifecycleRegistry,
): WorkflowServiceStubs {
  val builder = WorkflowServiceStubsOptions.newBuilder().setTarget(config.address)
  config.authToken?.takeIf(String::isNotBlank)?.let { token ->
    val bearerToken = if (token.startsWith("Bearer ", ignoreCase = true)) token else "Bearer $token"
    builder.addGrpcMetadataProvider(
      AuthorizationGrpcMetadataProvider(
        AuthorizationTokenSupplier { bearerToken },
      ),
    )
  }
  val stubs = WorkflowServiceStubs.newServiceStubs(builder.build())
  lifecycle.register { stubs.shutdown() }
  return stubs
}

private fun provideWorkflowClient(
  config: TemporalConfig,
  stubs: WorkflowServiceStubs,
): WorkflowClient {
  val objectMapper =
    jacksonObjectMapper()
      .findAndRegisterModules()
      .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
  val dataConverter =
    DefaultDataConverter
      .newDefaultInstance()
      .withPayloadConverterOverrides(JacksonJsonPayloadConverter(objectMapper))
  val options =
    WorkflowClientOptions
      .newBuilder()
      .setNamespace(config.namespace)
      .setIdentity(config.identity)
      .setDataConverter(dataConverter)
      .setContextPropagators(listOf(GrafTelemetry.openTelemetryContextPropagator()))
      .build()
  return WorkflowClient.newInstance(stubs, options)
}

private fun loadServiceAccountToken(path: String): String =
  FileInputStream(path).use { stream ->
    stream.bufferedReader().readText().trim()
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
