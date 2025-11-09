package ai.proompteng.graf.di

import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.config.TemporalConfig
import ai.proompteng.graf.neo4j.Neo4jClient
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.header
import io.ktor.serialization.kotlinx.json.json
import io.minio.MinioClient
import io.temporal.authorization.AuthorizationGrpcMetadataProvider
import io.temporal.authorization.AuthorizationTokenSupplier
import io.temporal.client.WorkflowClient
import io.temporal.client.WorkflowClientOptions
import io.temporal.serviceclient.WorkflowServiceStubs
import io.temporal.serviceclient.WorkflowServiceStubsOptions
import io.temporal.worker.WorkerFactory
import kotlinx.serialization.json.Json
import org.koin.dsl.module
import org.koin.dsl.onClose
import org.neo4j.driver.AuthTokens
import org.neo4j.driver.GraphDatabase
import java.io.FileInputStream
import java.net.URI
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.TrustManagerFactory

/**
 * Packages long-lived infrastructure clients that should be shared across the application.
 */
val infrastructureModule =
  module {
    single {
      buildNeo4jClient(get())
    } onClose {
      it?.close()
    }

    single {
      buildMinioClient(get())
    } onClose {
      it?.close()
    }

    single {
      buildKubernetesHttpClient(get(), get())
    } onClose {
      it?.close()
    }

    single {
      buildWorkflowServiceStubs(get())
    } onClose {
      it?.shutdown()
    }

    single {
      buildWorkflowClient(get(), get())
    }

    single {
      WorkerFactory.newInstance(get())
    } onClose {
      it?.shutdown()
    }
  }

private fun buildNeo4jClient(config: Neo4jConfig): Neo4jClient =
  Neo4jClient(
    GraphDatabase.driver(
      config.uri,
      AuthTokens.basic(config.username, config.password),
      config.toDriverConfig(),
    ),
    config.database,
  )

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

private fun buildKubernetesHttpClient(
  config: ArgoConfig,
  json: Json,
): HttpClient {
  val trustManager = loadTrustManager(config.caCertPath)
  val token = loadServiceAccountToken(config.tokenPath)
  return HttpClient(CIO) {
    install(ContentNegotiation) {
      json(json)
    }
    defaultRequest {
      header("Authorization", "Bearer $token")
    }
    engine {
      https {
        this.trustManager = trustManager
      }
    }
  }
}

private fun buildWorkflowServiceStubs(config: TemporalConfig): WorkflowServiceStubs {
  val builder = WorkflowServiceStubsOptions.newBuilder().setTarget(config.address)
  config.authToken?.takeIf(String::isNotBlank)?.let { token ->
    val bearerToken = if (token.startsWith("Bearer ", ignoreCase = true)) token else "Bearer $token"
    builder.addGrpcMetadataProvider(
      AuthorizationGrpcMetadataProvider(AuthorizationTokenSupplier { bearerToken }),
    )
  }
  return WorkflowServiceStubs.newInstance(builder.build())
}

private fun buildWorkflowClient(
  stubs: WorkflowServiceStubs,
  config: TemporalConfig,
): WorkflowClient =
  WorkflowClient.newInstance(
    stubs,
    WorkflowClientOptions
      .newBuilder()
      .setNamespace(config.namespace)
      .setIdentity(config.identity)
      .build(),
  )

private fun loadServiceAccountToken(path: String): String = FileInputStream(path).use { it.bufferedReader().readText().trim() }

private fun loadTrustManager(caPath: String) =
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
    factory.trustManagers.firstOrNull()
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
