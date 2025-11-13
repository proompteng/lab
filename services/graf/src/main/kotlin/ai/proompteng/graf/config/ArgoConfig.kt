package ai.proompteng.graf.config

data class ArgoConfig(
  val apiServer: String,
  val namespace: String,
  val workflowTemplateName: String,
  val serviceAccountName: String,
  val tokenPath: String,
  val caCertPath: String,
  val pollIntervalSeconds: Long,
  val pollTimeoutSeconds: Long,
) {
  companion object {
    const val DEFAULT_POLL_TIMEOUT_SECONDS = 7200L

    fun fromEnvironment(env: Map<String, String> = System.getenv()): ArgoConfig {
      val apiServer =
        env["ARGO_API_SERVER"]?.takeIf { it.isNotBlank() }
          ?: "https://kubernetes.default.svc"
      val namespace = env["ARGO_NAMESPACE"]?.takeIf { it.isNotBlank() } ?: "argo-workflows"
      val templateName =
        env["ARGO_WORKFLOW_TEMPLATE_NAME"]?.takeIf { it.isNotBlank() }
          ?: "codex-research-workflow"
      val serviceAccount =
        env["ARGO_WORKFLOW_SERVICE_ACCOUNT"]?.takeIf { it.isNotBlank() }
          ?: "graf"
      val tokenPath =
        env["ARGO_SERVICE_ACCOUNT_TOKEN_PATH"]?.takeIf { it.isNotBlank() }
          ?: "/var/run/secrets/kubernetes.io/serviceaccount/token"
      val caPath =
        env["ARGO_CA_CERT_PATH"]?.takeIf { it.isNotBlank() }
          ?: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
      val pollIntervalSeconds = env["ARGO_WORKFLOW_POLL_INTERVAL_SECONDS"]?.toLongOrNull() ?: 10L
      val pollTimeoutSeconds =
        env["ARGO_WORKFLOW_POLL_TIMEOUT_SECONDS"]?.toLongOrNull() ?: DEFAULT_POLL_TIMEOUT_SECONDS
      return ArgoConfig(
        apiServer = apiServer,
        namespace = namespace,
        workflowTemplateName = templateName,
        serviceAccountName = serviceAccount,
        tokenPath = tokenPath,
        caCertPath = caPath,
        pollIntervalSeconds = pollIntervalSeconds,
        pollTimeoutSeconds = pollTimeoutSeconds,
      )
    }
  }
}
