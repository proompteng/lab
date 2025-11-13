package ai.proompteng.graf.config

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull

class ArgoConfigTest {
  @Test
  fun `fromEnvironment uses defaults when unset`() {
    val config = ArgoConfig.fromEnvironment(emptyMap())

    assertEquals("https://kubernetes.default.svc", config.apiServer)
    assertEquals("argo-workflows", config.namespace)
    assertEquals("codex-research-workflow", config.workflowTemplateName)
    assertEquals("graf", config.serviceAccountName)
    assertEquals("/var/run/secrets/kubernetes.io/serviceaccount/token", config.tokenPath)
    assertEquals("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", config.caCertPath)
    assertEquals(10L, config.pollIntervalSeconds)
    assertEquals(ArgoConfig.DEFAULT_POLL_TIMEOUT_SECONDS, config.pollTimeoutSeconds)
  }

  @Test
  fun `fromEnvironment parses overrides`() {
    val env =
      mapOf(
        "ARGO_API_SERVER" to "https://argo.internal",
        "ARGO_NAMESPACE" to "research",
        "ARGO_WORKFLOW_TEMPLATE_NAME" to "custom-template",
        "ARGO_WORKFLOW_SERVICE_ACCOUNT" to "graf-service-account",
        "ARGO_SERVICE_ACCOUNT_TOKEN_PATH" to "/tmp/token",
        "ARGO_CA_CERT_PATH" to "/tmp/ca.crt",
        "ARGO_WORKFLOW_POLL_INTERVAL_SECONDS" to "22",
        "ARGO_WORKFLOW_POLL_TIMEOUT_SECONDS" to "33",
      )

    val config = ArgoConfig.fromEnvironment(env)

    assertEquals("https://argo.internal", config.apiServer)
    assertEquals("research", config.namespace)
    assertEquals("custom-template", config.workflowTemplateName)
    assertEquals("graf-service-account", config.serviceAccountName)
    assertEquals("/tmp/token", config.tokenPath)
    assertEquals("/tmp/ca.crt", config.caCertPath)
    assertEquals(22L, config.pollIntervalSeconds)
    assertEquals(33L, config.pollTimeoutSeconds)
  }
}

class TemporalConfigTest {
  @Test
  fun `fromEnvironment supplies defaults`() {
    val config = TemporalConfig.fromEnvironment(emptyMap())

    assertEquals("temporal-frontend.temporal.svc.cluster.local:7233", config.address)
    assertEquals("default", config.namespace)
    assertEquals("graf-codex-research", config.taskQueue)
    assertEquals("graf", config.identity)
    assertNull(config.authToken)
  }

  @Test
  fun `fromEnvironment applies overrides and keeps auth token`() {
    val env =
      mapOf(
        "TEMPORAL_ADDRESS" to "temporal.internal:443",
        "TEMPORAL_NAMESPACE" to "graf",
        "TEMPORAL_TASK_QUEUE" to "codex",
        "TEMPORAL_IDENTITY" to "graf-api",
        "TEMPORAL_AUTH_TOKEN" to "Bearer custom-token",
      )

    val config = TemporalConfig.fromEnvironment(env)

    assertEquals("temporal.internal:443", config.address)
    assertEquals("graf", config.namespace)
    assertEquals("codex", config.taskQueue)
    assertEquals("graf-api", config.identity)
    assertEquals("Bearer custom-token", config.authToken)
  }

  @Test
  fun `blank auth token is treated as null`() {
    val config = TemporalConfig.fromEnvironment(mapOf("TEMPORAL_AUTH_TOKEN" to "   "))

    assertNull(config.authToken)
  }
}

class Neo4jConfigTest {
  @Test
  fun `fromEnvironment prefers bundled auth string`() {
    val env =
      mapOf(
        "NEO4J_URI" to "bolt://graf-neo4j:7687",
        "NEO4J_AUTH" to "graf-user/super-secret",
        "NEO4J_DATABASE" to "research",
      )

    val config = Neo4jConfig.fromEnvironment(env)

    assertEquals("graf-user", config.username)
    assertEquals("super-secret", config.password)
    assertEquals("research", config.database)
  }

  @Test
  fun `fromEnvironment falls back to user and default database`() {
    val env =
      mapOf(
        "NEO4J_URI" to "bolt://graf-neo4j:7687",
        "NEO4J_USER" to "readonly",
        "NEO4J_PASSWORD" to "pw",
      )

    val config = Neo4jConfig.fromEnvironment(env)

    assertEquals("readonly", config.username)
    assertEquals("pw", config.password)
    assertEquals("neo4j", config.database)
  }

  @Test
  fun `missing password raises error`() {
    assertFailsWith<IllegalStateException> {
      Neo4jConfig.fromEnvironment(mapOf("NEO4J_URI" to "bolt://graf-neo4j:7687"))
    }
  }
}

class MinioConfigTest {
  @Test
  fun `artifactEndpoint preserves explicit https port`() {
    val config =
      MinioConfig(
        endpoint = "https://storage.internal:9443",
        bucket = "graf",
        accessKey = "key",
        secretKey = "secret",
        secure = true,
        region = null,
      )

    assertEquals("storage.internal:9443", config.artifactEndpoint)
  }

  @Test
  fun `artifactEndpoint falls back to 443 when secure`() {
    val config =
      MinioConfig(
        endpoint = "minio.cluster.svc",
        bucket = "graf",
        accessKey = "key",
        secretKey = "secret",
        secure = true,
        region = null,
      )

    assertEquals("minio.cluster.svc:443", config.artifactEndpoint)
  }

  @Test
  fun `artifactEndpoint falls back to 80 when insecure`() {
    val config =
      MinioConfig(
        endpoint = "minio.cluster.svc",
        bucket = "graf",
        accessKey = "key",
        secretKey = "secret",
        secure = false,
        region = null,
      )

    assertEquals("minio.cluster.svc:80", config.artifactEndpoint)
  }

  @Test
  fun `fromEnvironment parses booleans and region`() {
    val env =
      mapOf(
        "MINIO_ENDPOINT" to "minio-gateway:9000",
        "MINIO_BUCKET" to "graf-bucket",
        "MINIO_ACCESS_KEY" to "key",
        "MINIO_SECRET_KEY" to "secret",
        "MINIO_SECURE" to "false",
        "MINIO_REGION" to "us-west-2",
      )

    val config = MinioConfig.fromEnvironment(env)

    assertFalse(config.secure)
    assertEquals("us-west-2", config.region)
    assertEquals("minio-gateway:9000", config.artifactEndpoint)
  }
}
