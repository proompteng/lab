package ai.proompteng.graf

private val ansiRegex = Regex("\\u001B\\[[;\\d]*m")

internal fun formatAccessLog(method: String, path: String, statusCode: Int, durationMs: Long): String {
  val statusText = statusCode.toString()
  val durationText = if (durationMs >= 0) " in ${durationMs}ms" else ""
  return "$statusText $method - $path$durationText"
}

internal fun String.stripAnsi(): String = replace(ansiRegex, "")
