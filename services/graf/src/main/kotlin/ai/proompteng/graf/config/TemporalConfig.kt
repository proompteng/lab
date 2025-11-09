package ai.proompteng.graf.config

data class TemporalConfig(
  val address: String,
  val namespace: String,
  val taskQueue: String,
  val identity: String,
  val authToken: String?,
) {
  companion object {
    fun fromEnvironment(): TemporalConfig {
      val env = System.getenv()
      val address =
        env["TEMPORAL_ADDRESS"]?.takeIf { it.isNotBlank() }
          ?: "temporal-frontend.temporal.svc.cluster.local:7233"
      val namespace = env["TEMPORAL_NAMESPACE"]?.takeIf { it.isNotBlank() } ?: "default"
      val taskQueue = env["TEMPORAL_TASK_QUEUE"]?.takeIf { it.isNotBlank() } ?: "graf-codex-research"
      val identity = env["TEMPORAL_IDENTITY"]?.takeIf { it.isNotBlank() } ?: "graf"
      val authToken = env["TEMPORAL_AUTH_TOKEN"]?.takeIf { it.isNotBlank() }
      return TemporalConfig(address, namespace, taskQueue, identity, authToken)
    }
  }
}
