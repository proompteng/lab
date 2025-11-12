package ai.proompteng.graf.di

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
import ai.proompteng.graf.config.TemporalConfig
import ai.proompteng.graf.neo4j.Neo4jClient
import ai.proompteng.graf.services.GraphService
import io.minio.MinioClient
import io.temporal.client.WorkflowClient
import jakarta.enterprise.inject.Produces
import jakarta.inject.Singleton
import kotlinx.serialization.json.Json
import java.net.http.HttpClient

@Suppress("ktlint:standard:function-expression-body", "ktlint:standard:function-signature")
@Singleton
class ServiceProducers {
  @Singleton
  @Produces
  fun graphService(neo4jClient: Neo4jClient): GraphService = GraphService(neo4jClient)

  @Singleton
  @Produces
  fun minioArtifactFetcher(minioClient: MinioClient): MinioArtifactFetcher = MinioArtifactFetcherImpl(minioClient)

  @Singleton
  @Produces
  fun argoWorkflowClient(
    argoConfig: ArgoConfig,
    kubernetesHttpClient: HttpClient,
    minioConfig: MinioConfig,
    @GrafJson json: Json,
    @ArgoServiceAccountToken argoToken: String,
  ): ArgoWorkflowClient = ArgoWorkflowClient(argoConfig, kubernetesHttpClient, minioConfig, json, argoToken)

  @Singleton
  @Produces
  fun codexResearchActivities(
    argoWorkflowClient: ArgoWorkflowClient,
    graphService: GraphService,
    artifactFetcher: MinioArtifactFetcher,
    @GrafJson json: Json,
  ): CodexResearchActivities = CodexResearchActivitiesImpl(argoWorkflowClient, graphService, artifactFetcher, json)

  @Singleton
  @Produces
  fun codexResearchService(
    workflowClient: WorkflowClient,
    temporalConfig: TemporalConfig,
    argoConfig: ArgoConfig,
  ): CodexResearchService = CodexResearchService(workflowClient, temporalConfig.taskQueue, argoConfig.pollTimeoutSeconds)

  @Singleton
  @Produces
  fun autoResearchLauncher(codexResearchService: CodexResearchService): AutoResearchLauncher = AutoResearchService(codexResearchService)
}
