package ai.proompteng.graf

import ai.proompteng.graf.autoresearch.AgentActivitiesImpl
import ai.proompteng.graf.autoresearch.AutoResearchAgentService
import ai.proompteng.graf.autoresearch.AutoResearchPlannerService
import ai.proompteng.graf.autoresearch.AutoResearchWorkflowImpl
import ai.proompteng.graf.autoresearch.Neo4jGraphSnapshotProvider
import ai.proompteng.graf.autoresearch.AutoResearchFollowupActivitiesImpl
import ai.proompteng.graf.codex.ArgoWorkflowClient
import ai.proompteng.graf.codex.CodexResearchActivitiesImpl
import ai.proompteng.graf.codex.CodexResearchService
import ai.proompteng.graf.codex.CodexResearchWorkflowImpl
import ai.proompteng.graf.codex.MinioArtifactFetcherImpl
import ai.proompteng.graf.config.ArgoConfig
import ai.proompteng.graf.config.AutoResearchConfig
import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.config.TemporalConfig
import ai.proompteng.graf.neo4j.Neo4jClient
import ai.proompteng.graf.routes.graphRoutes
import ai.proompteng.graf.security.ApiBearerTokenConfig
import ai.proompteng.graf.services.GraphService
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.header
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.application.log
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.bearer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
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
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import org.neo4j.driver.AuthTokens
import org.neo4j.driver.GraphDatabase
import org.slf4j.event.Level
import java.io.FileInputStream
import java.net.URI
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.TrustManagerFactory
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation as ServerContentNegotiation

private val buildVersion = System.getenv("GRAF_VERSION") ?: "dev"
private val buildCommit = System.getenv("GRAF_COMMIT") ?: "unknown"
private const val GRAF_BEARER_AUTH_NAME = "graf-bearer"

private data class AutoResearchRuntime(
  val agentService: AutoResearchAgentService,
  val agentActivities: AgentActivitiesImpl,
  val followupActivities: AutoResearchFollowupActivitiesImpl,
  val planner: AutoResearchPlannerService,
)

fun main() {
  val port = System.getenv("PORT")?.toIntOrNull() ?: 8080
  val neo4jConfig = Neo4jConfig.fromEnvironment()
  val driver =
    GraphDatabase.driver(
      neo4jConfig.uri,
      AuthTokens.basic(neo4jConfig.username, neo4jConfig.password),
      neo4jConfig.toDriverConfig(),
    )
  val client = Neo4jClient(driver, neo4jConfig.database)
  val graphService = GraphService(client)

  val temporalConfig = TemporalConfig.fromEnvironment()
  val argoConfig = ArgoConfig.fromEnvironment()
  val minioConfig = MinioConfig.fromEnvironment()
  val agentConfig = AutoResearchConfig.fromEnvironment()

  val temporalObjectMapper =
    jacksonObjectMapper()
      .findAndRegisterModules()
      .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
  val temporalDataConverter =
    DefaultDataConverter
      .newDefaultInstance()
      .withPayloadConverterOverrides(JacksonJsonPayloadConverter(temporalObjectMapper))

  val sharedJson =
    Json {
      encodeDefaults = true
      prettyPrint = false
      explicitNulls = false
      ignoreUnknownKeys = true
    }

  val kubernetesToken = loadServiceAccountToken(argoConfig.tokenPath)
  val kubernetesClient = buildKubernetesHttpClient(argoConfig, kubernetesToken, sharedJson)
  val minioClient = buildMinioClient(minioConfig)
  val artifactFetcher = MinioArtifactFetcherImpl(minioClient)
  val argoClient = ArgoWorkflowClient(argoConfig, kubernetesClient, minioConfig, sharedJson)
  val codexActivities = CodexResearchActivitiesImpl(argoClient, graphService, artifactFetcher, sharedJson)

  val serviceStubsBuilder =
    WorkflowServiceStubsOptions.newBuilder().setTarget(temporalConfig.address)
  temporalConfig.authToken?.takeIf { it.isNotBlank() }?.let { token ->
    val bearerToken =
      if (token.startsWith("Bearer ", ignoreCase = true)) token else "Bearer $token"
    serviceStubsBuilder.addGrpcMetadataProvider(
      AuthorizationGrpcMetadataProvider(AuthorizationTokenSupplier { bearerToken }),
    )
  }
  val serviceStubs = WorkflowServiceStubs.newServiceStubs(serviceStubsBuilder.build())
  val workflowClient =
    WorkflowClient.newInstance(
      serviceStubs,
      WorkflowClientOptions
        .newBuilder()
        .setNamespace(temporalConfig.namespace)
        .setIdentity(temporalConfig.identity)
        .setDataConverter(temporalDataConverter)
        .build(),
    )
  val codexResearchService = CodexResearchService(workflowClient, temporalConfig.taskQueue, argoConfig.pollTimeoutSeconds)
  val workerFactory = WorkerFactory.newInstance(workflowClient)
  val autoResearchRuntime =
    if (agentConfig.isReady) {
      val snapshotProvider = Neo4jGraphSnapshotProvider(client, agentConfig.graphSampleLimit)
      val agentService = AutoResearchAgentService(agentConfig, snapshotProvider, sharedJson)
      val agentActivities = AgentActivitiesImpl(agentService)
      val planner = AutoResearchPlannerService(workflowClient, temporalConfig.taskQueue, agentConfig.graphSampleLimit)
      val followupActivities = AutoResearchFollowupActivitiesImpl(codexResearchService)
      AutoResearchRuntime(agentService, agentActivities, followupActivities, planner)
    } else {
      null
    }
  val worker = workerFactory.newWorker(temporalConfig.taskQueue)
  worker.registerWorkflowImplementationTypes(CodexResearchWorkflowImpl::class.java)
  autoResearchRuntime?.let {
    worker.registerWorkflowImplementationTypes(AutoResearchWorkflowImpl::class.java)
  }
  val activityImplementations =
    buildList {
      add(codexActivities as Any)
      autoResearchRuntime?.let {
        add(it.agentActivities as Any)
        add(it.followupActivities as Any)
      }
    }
  worker.registerActivitiesImplementations(*activityImplementations.toTypedArray())
  workerFactory.start()

  val autoResearchPlannerService = autoResearchRuntime?.planner

  val server =
    embeddedServer(Netty, port) {
      module(graphService, codexResearchService, minioConfig, sharedJson, autoResearchPlannerService)
    }

  Runtime.getRuntime().addShutdownHook(
    Thread {
      if (!client.isClosed) {
        client.close()
      }
      workerFactory.shutdown()
      serviceStubs.shutdown()
      kubernetesClient.close()
      minioClient.close()
      autoResearchRuntime?.agentService?.close()
    },
  )
  server.start(wait = true)
}

@OptIn(ExperimentalSerializationApi::class)
fun Application.module(
  graphService: GraphService,
  codexResearchService: CodexResearchService,
  minioConfig: MinioConfig,
  jsonConfig: Json,
  autoResearchPlannerService: AutoResearchPlannerService?,
) {
  install(ServerContentNegotiation) {
    json(jsonConfig)
  }
  install(CallLogging) {
    level = Level.INFO
  }
  install(CORS) {
    anyHost()
    allowHeader("Authorization")
    allowHeader("Content-Type")
    allowMethod(HttpMethod.Get)
    allowMethod(HttpMethod.Post)
    allowMethod(HttpMethod.Patch)
    allowMethod(HttpMethod.Delete)
    allowMethod(HttpMethod.Options)
    allowCredentials = true
  }
  install(StatusPages) {
    exception<IllegalArgumentException> { call, cause ->
      call.application.log.warn("Bad request", cause)
      call.respondText(status = HttpStatusCode.BadRequest, text = cause.message ?: "invalid payload")
    }
    exception<Throwable> { call, cause ->
      call.application.log.error("Unhandled exception", cause)
      call.respondText(status = HttpStatusCode.InternalServerError, text = "internal server error")
    }
  }
  install(Authentication) {
    bearer(GRAF_BEARER_AUTH_NAME) {
      realm = "graf-graph-api"
      authenticate { credential ->
        if (ApiBearerTokenConfig.isValid(credential.token)) {
          UserIdPrincipal("graf")
        } else {
          null
        }
      }
    }
  }
  routing {
    get("/") {
      call.respond(
        mapOf(
          "service" to "graf",
          "status" to "ok",
          "version" to buildVersion,
          "commit" to buildCommit,
        ),
      )
    }
    route("/v1") {
      authenticate(GRAF_BEARER_AUTH_NAME) {
        graphRoutes(graphService, codexResearchService, minioConfig, autoResearchPlannerService)
      }
    }
    get("/healthz") {
      call.respond(mapOf("status" to "ok", "port" to System.getenv("PORT")))
    }
  }
}

private fun buildKubernetesHttpClient(
  config: ArgoConfig,
  token: String,
  jsonConfig: Json,
): HttpClient {
  val trustManager = loadTrustManager(config.caCertPath)
  return HttpClient(CIO) {
    install(ContentNegotiation) {
      json(jsonConfig)
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
