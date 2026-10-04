package ai.proompteng.graf.config

data class AgentsConfig(
  val baseUrl: String,
  val namespace: String,
  val agentName: String,
  val serviceAccountName: String,
  val tokenPath: String?,
  val bearerToken: String?,
  val pollIntervalSeconds: Long,
  val pollTimeoutSeconds: Long,
  val ttlSecondsAfterFinished: Long,
  val secretBindingRef: String?,
  val secrets: List<String>,
) {
  companion object {
    const val DEFAULT_POLL_TIMEOUT_SECONDS = 7200L
    const val DEFAULT_TTL_SECONDS_AFTER_FINISHED = 7200L

    fun fromEnvironment(env: Map<String, String> = System.getenv()): AgentsConfig {
      val baseUrl =
        env["AGENTS_BASE_URL"]?.takeIf { it.isNotBlank() }
          ?: "http://agents.agents.svc.cluster.local"
      val namespace = env["AGENTS_NAMESPACE"]?.takeIf { it.isNotBlank() } ?: "agents"
      val agentName = env["AGENTS_GRAF_AGENT_NAME"]?.takeIf { it.isNotBlank() } ?: "graf-codex-agent"
      val serviceAccount =
        env["AGENTS_SERVICE_ACCOUNT_NAME"]?.takeIf { it.isNotBlank() }
          ?: "agents-sa"
      val tokenPath =
        env["AGENTS_SERVICE_ACCOUNT_TOKEN_PATH"]?.takeIf { it.isNotBlank() }
      val bearerToken = env["AGENTS_BEARER_TOKEN"]?.takeIf { it.isNotBlank() }
      val pollIntervalSeconds =
        env["AGENTS_RUN_POLL_INTERVAL_SECONDS"]?.toLongOrNull()
          ?: 10L
      val pollTimeoutSeconds =
        env["AGENTS_RUN_POLL_TIMEOUT_SECONDS"]?.toLongOrNull()
          ?: DEFAULT_POLL_TIMEOUT_SECONDS
      val ttlSecondsAfterFinished =
        env["AGENTS_RUN_TTL_SECONDS_AFTER_FINISHED"]?.toLongOrNull()
          ?: DEFAULT_TTL_SECONDS_AFTER_FINISHED
      val secretBindingRef = env["AGENTS_SECRET_BINDING_REF"]?.takeIf { it.isNotBlank() } ?: "codex-github-token"
      val secrets =
        env["AGENTS_RUN_SECRETS"]
          ?.split(",")
          ?.map { it.trim() }
          ?.filter { it.isNotEmpty() }
          ?.takeIf { it.isNotEmpty() }
          ?: listOf("github-token", "codex-auth", "graf-api", "observability-minio-creds", "nats-agents-credentials")

      return AgentsConfig(
        baseUrl = baseUrl.trimEnd('/'),
        namespace = namespace,
        agentName = agentName,
        serviceAccountName = serviceAccount,
        tokenPath = tokenPath,
        bearerToken = bearerToken,
        pollIntervalSeconds = pollIntervalSeconds,
        pollTimeoutSeconds = pollTimeoutSeconds,
        ttlSecondsAfterFinished = ttlSecondsAfterFinished,
        secretBindingRef = secretBindingRef,
        secrets = secrets,
      )
    }
  }
}
