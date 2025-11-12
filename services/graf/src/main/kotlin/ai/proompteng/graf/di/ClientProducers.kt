package ai.proompteng.graf.di

import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.config.MinioEndpointTarget
import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.config.TemporalConfig
import ai.proompteng.graf.config.resolveMinioEndpoint
import ai.proompteng.graf.neo4j.Neo4jClient
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
import jakarta.annotation.PreDestroy
import jakarta.enterprise.inject.Produces
import jakarta.inject.Singleton
import org.neo4j.driver.AuthTokens
import org.neo4j.driver.GraphDatabase
import java.io.FileInputStream
import java.net.http.HttpClient
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory

@Suppress("ktlint:standard:function-expression-body", "ktlint:standard:function-signature")
@Singleton
class ClientProducers(
  private val neo4jConfig: Neo4jConfig,
  private val minioConfig: MinioConfig,
  private val argoConfig: ArgoConfig,
  private val temporalConfig: TemporalConfig,
) {
  private val neo4jDriver =
    GraphDatabase.driver(
      neo4jConfig.uri,
      AuthTokens.basic(neo4jConfig.username, neo4jConfig.password),
      neo4jConfig.toDriverConfig(),
    )

  private val neo4jClient = Neo4jClient(neo4jDriver, neo4jConfig.database)
  private val minioClient = buildMinioClient(minioConfig)
  private val kubernetesToken = loadServiceAccountToken(argoConfig.tokenPath)
  private val kubernetesHttpClient = buildKubernetesHttpClient(argoConfig)

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
  private val workerFactory = WorkerFactory.newInstance(workflowClient)

  @Singleton
  @Produces
  fun neo4jClient(): Neo4jClient = neo4jClient

  @Singleton
  @Produces
  fun minioClient(): MinioClient = minioClient

  @Singleton
  @Produces
  fun kubernetesHttpClient(): HttpClient = kubernetesHttpClient

  @Singleton
  @Produces
  fun workflowServiceStubs(): WorkflowServiceStubs = serviceStubs

  @Singleton
  @Produces
  fun workflowClient(): WorkflowClient = workflowClient

  @Singleton
  @Produces
  fun workerFactory(): WorkerFactory = workerFactory

  @Singleton
  @Produces
  @ArgoServiceAccountToken
  fun argoServiceAccountToken(): String = kubernetesToken

  @PreDestroy
  fun cleanup() {
    serviceStubs.shutdown()
    minioClient.close()
    neo4jClient.close()
  }
}

private fun buildServiceStubs(config: TemporalConfig): WorkflowServiceStubs {
  val builder = WorkflowServiceStubsOptions.newBuilder().setTarget(config.address)
  config.authToken?.takeIf(String::isNotBlank)?.let { token ->
    val bearerToken = if (token.startsWith("Bearer ", ignoreCase = true)) token else "Bearer $token"
    builder.addGrpcMetadataProvider(
      AuthorizationGrpcMetadataProvider(
        AuthorizationTokenSupplier { bearerToken },
      ),
    )
  }
  return WorkflowServiceStubs.newServiceStubs(builder.build())
}

private fun buildMinioClient(config: MinioConfig): MinioClient {
  val builder =
    MinioClient
      .builder()
      .credentials(config.accessKey, config.secretKey)
  when (val target = resolveMinioEndpoint(config)) {
    is MinioEndpointTarget.Url -> builder.endpoint(target.value)
    is MinioEndpointTarget.HostPort ->
      builder.endpoint(target.host, target.port, target.secure)
  }
  config.region?.let { builder.region(it) }
  return builder.build()
}

@Suppress("ktlint:standard:function-signature")
private fun loadServiceAccountToken(path: String): String =
  FileInputStream(path).use { it.bufferedReader().readText().trim() }

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

@Suppress("ktlint:standard:function-signature")
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
